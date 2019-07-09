/**
 * @license
 * Copyright 2018 Streamlit Inc. All rights reserved.
 *
 * WebsocketConnection State Machine:
 *
 *   INITIAL
 *     │
 *     │                on conn succeed
 *     v                :
 *   INITIAL_CONNECTING ──────> CONNECTED
 *     │                          │  ^
 *     │:on timeout/error/closed  │  │
 *     v                          │:on error/closed
 *   DISCONNECTED <───────┬───────┘  │
 *     │                  │          │
 *     │:on timer start   │          │:on conn succeed
 *     v                  │          │
 *   WAITING              │          │
 *     │                  │:on timeout/error/closed
 *     │:on timer fired   │          │
 *     v                  │          │
 *   RECONNECTING ════════╛──────────┘
 *     │
 *     │:on retries exhausted
 *     v
 *   DISCONNECTED_FOREVER
 *
 */

import {ConnectionState} from './ConnectionState'
import {ForwardMsg, BackMsg, IBackMsg} from 'autogen/protobuf'
import {logMessage, logError} from './log'


/**
 * Name of the logger.
 */
const LOG = 'WebsocketConnection'


/**
 * Number of times to try to connect to a remote websocket.
 */
const REMOTE_CONNECTION_MAX_RETRIES = 5


/**
 * Wait this long before trying to reconnect.
 * This must be <= bootstrap.py#BROWSER_WAIT_TIMEOUT_SEC / 2.
 * IMPORTANT: This number and CONNECTION_ATTEMPT_TIMEOUT_MS are finicky! The
 * WebSocket doesn't seem to close immediately when you tell it to. If you
 * change this, please do *a metric ton* of tests.
 */
const RECONNECT_WAIT_TIME_MS = 500


/**
 * Timeout when attempting to connect to a websocket, in millis.
 * IMPORTANT: This number and RECONNECT_WAIT_TIME_MS are finicky! The WebSocket
 * doesn't seem to close immediately when you tell it to. If you change this,
 * please do *a metric ton* of tests.
 */
const CONNECTION_ATTEMPT_TIMEOUT_MS = 5000


type OnMessage = (ForwardMsg: any) => void
type OnConnectionStateChange = (connectionState: ConnectionState, errMsg?: string) => void


interface Props {
  /**
   * List of URLs to connect to. We'll try the first, then the second, etc. If
   * all fail, we'll retry from the top. The number of retries depends on
   * whether this is a local connection.
   */
  uriList: string[];

  /**
   * Function called when our ConnectionState changes.
   * If the new ConnectionState is ERROR, errMsg will be defined.
   */
  onConnectionStateChange: OnConnectionStateChange;

  /** Function called when we receive a new message. */
  onMessage: OnMessage;

  /**
   * True if connecting to localhost. The reconnect behavior is different in
   * that case.
   */
  isLocal: boolean;
}

interface MessageQueue {
  [index: number]: any;
}


type Event =
  'CONNECTION_CLOSED'
  | 'CONNECTION_ERROR'
  | 'CONNECTION_WTF'
  | 'CONNECTION_SUCCEEDED'
  | 'CONNECTION_TIMED_OUT'
  | 'RETRIES_EXHAUSTED'
  | 'WAIT_TIMER_FIRED'
  | 'WAIT_TIMER_STARTED'


/**
 * This class is the "brother" of StaticConnection. The class connects to the
 * server and gets deltas over a websocket connection.
 */
export class WebsocketConnection {
  /**
   * List of URIs to try to connect to in round-robin fashion.
   */
  private readonly uriList: string[];

  /**
   * Index to the URI in uriList that we're going to try to connect to.
   */
  private uriIndex: number = 0;

  /**
   * Function that tells the outside world that the connection state has
   * changed.
   */
  private readonly onConnectionStateChange: OnConnectionStateChange;

  /**
   * Function that receives incoming messages, so they can be handled by the
   * app at large.
   */
  private readonly onMessage: OnMessage;

  /**
   * True if this Streamlit server that is serving this web app is running from
   * the same computer as this browser.
   */
  private readonly isLocal: boolean;

  /**
   * How many times to retry connecting. May be Infinity!
   */
  private readonly maxRetries: number;

  /**
   * To guarantee packet transmission order, this is the index of the last
   * dispatched incoming message.
   */
  private lastDispatchedMessageIndex = -1;

  /**
   * And this is the index of the next message we recieve.
   */
  private nextMessageIndex = 0;

  /**
   * This dictionary stores recieved messages that we haven't sent out yet
   * (because we're still decoding previous messages)
   */
  private messageQueue: MessageQueue = {};

  /**
   * The current state of this object's state machine.
   */
  private state = ConnectionState.INITIAL;

  /**
   * The WebSocket object we're connecting with.
   */
  private websocket?: (WebSocket | null);

  /**
   * Keep track of how many times we tried to connect. For each "attempt" we
   * try *every* URI in uriList.
   */
  private attemptNumber = 0;

  /**
   * WebSocket objects don't support retries, so we have to implement them
   * ourselves. We use setTimeout to wait for a connection and retry once the
   * timeout fire. This is the timer ID from setTimeout, so we can cancel it if
   * needed.
   */
  private connectionTimeoutId?: number;

  /**
   * Constructor.
   *
   * How this WebsocketConnection handles retries:
   *
   * - If isLocal == true: attempt to connect, and retry forever if it fails.
   *   Before retrying, wait RECONNECT_WAIT_TIME_MS, just so we don't hog the
   *   CPU (since most times the connection fails immediately). If the
   *   connection succeeds and then it fails (ctrl-c on the terminal), also
   *   retry forever just like before.
   *
   * - If isLocal == false: attempt to connect, and retry "maxRetries" times
   *   where during each "try" we attempt to connect to each of the URIs in
   *   urlList. Wait RECONNECT_WAIT_TIME_MS between retries just as before. The
   *   difference here is that most times the connection doesn't fail
   *   immediately (it can take a few hundred millis), so the reason why we
   *   wait a bit is not to keep the CPU happy but to give the remote server a
   *   chance to start up. After maxRetries, just error out and stop retrying.
   */
  public constructor(props: Props) {
    this.uriList = props.uriList
    this.onConnectionStateChange = props.onConnectionStateChange
    this.onMessage = props.onMessage
    this.isLocal = props.isLocal
    this.maxRetries = props.isLocal ?
      Infinity : REMOTE_CONNECTION_MAX_RETRIES

    // This is the only time setState() should be called outside of
    // stepStateMachine().
    this.setState(ConnectionState.INITIAL_CONNECTING)
  }

  // This should only be called inside the constructor and stepStateMachine().
  private setState(state: ConnectionState, msg?: string): void {
    logMessage(LOG, `New state: ${state}`)
    this.state = state
    this.onConnectionStateChange(state, msg)

    // Perform actions when entering certain states.
    switch (this.state) {
      case ConnectionState.INITIAL_CONNECTING:
        this.startConnectionAttempt()
        break

      case ConnectionState.DISCONNECTED:
        this.websocket = null
        this.waitBeforeConnectionAttempt()
        break

      case ConnectionState.RECONNECTING:
        this.continueConnectionAttempt()
        break

      case ConnectionState.DISCONNECTED_FOREVER:
      case ConnectionState.STATIC:
        this.websocket = null
        break

      case ConnectionState.CONNECTED:
      case ConnectionState.INITIAL:
      default:
        break
    }
  }

  private stepStateMachine(event: Event): void {
    logMessage(LOG, `State: ${this.state}; Event: ${event}`)

    // In case there's a connection in progress, stop the connection timeout
    // timer.
    if (this.connectionTimeoutId != null) {
      window.clearTimeout(this.connectionTimeoutId)
    }

    // Anything combination of state+event that is not explicitly called out
    // below is illegal and raises an error.

    switch (this.state) {
      case ConnectionState.INITIAL:
        this.setState(ConnectionState.INITIAL_CONNECTING)
        break

      case ConnectionState.INITIAL_CONNECTING:
      case ConnectionState.RECONNECTING:
        if (event === 'CONNECTION_SUCCEEDED') {
          this.setState(ConnectionState.CONNECTED)
          return

        } else if (event === 'CONNECTION_TIMED_OUT' ||
                   event === 'CONNECTION_ERROR' ||
                   event === 'CONNECTION_CLOSED') {
          this.setState(ConnectionState.DISCONNECTED)
          return

        } else if (event === 'RETRIES_EXHAUSTED') {
          this.setState(ConnectionState.DISCONNECTED_FOREVER, 'Retries exhausted')
          return
        }
        break

      case ConnectionState.CONNECTED:
        if (event === 'CONNECTION_CLOSED' ||
            event === 'CONNECTION_ERROR') {
          this.setState(ConnectionState.DISCONNECTED)
          return
        }
        break

      case ConnectionState.DISCONNECTED:
        if (event === 'WAIT_TIMER_STARTED') {
          this.setState(ConnectionState.WAITING)
          return
        }
        break

      case ConnectionState.WAITING:
        if (event === 'WAIT_TIMER_FIRED') {
          this.setState(ConnectionState.RECONNECTING)
          return
        }
        break

      case ConnectionState.STATIC:
      case ConnectionState.DISCONNECTED_FOREVER:
      default:
        break
    }

    throw new Error(
      'Unsupported state transition.\n' +
      `State: ${this.state}\n` +
      `Event: ${event}`)
  }

  private startConnectionAttempt(): void {
    this.uriIndex = 0
    this.connectToWebSocket()
  }

  private waitBeforeConnectionAttempt(): void {
    window.setTimeout(
      () => this.stepStateMachine('WAIT_TIMER_FIRED'),
      RECONNECT_WAIT_TIME_MS)
    this.stepStateMachine('WAIT_TIMER_STARTED')
  }

  private continueConnectionAttempt(): void {
    this.uriIndex++

    if (this.uriIndex >= this.uriList.length) {
      this.attemptNumber++
      if (this.attemptNumber < this.maxRetries) {
        this.uriIndex = 0
      } else {
        this.stepStateMachine('RETRIES_EXHAUSTED')
        return
      }
    }

    this.connectToWebSocket()
  }

  private connectToWebSocket(): void {
    const uri = this.uriList[this.uriIndex]

    if (this.websocket != null) {
      logMessage(LOG, 'closing WebSocket')
      this.websocket.close()
    }

    logMessage(LOG, 'creating WebSocket')
    this.websocket = new WebSocket(uri)

    this.setConnectionTimeout()

    const localWebsocket = this.websocket

    const checkWebsocket = (): boolean => {
      return localWebsocket === this.websocket
    }

    this.websocket.onmessage = (event: MessageEvent) => {
      if (checkWebsocket()) {
        this.handleMessage(event.data)
      }
    }

    this.websocket.onopen = () => {
      if (checkWebsocket()) {
        logMessage(LOG, 'WebSocket onopen')
        this.stepStateMachine('CONNECTION_SUCCEEDED')
      }
    }

    this.websocket.onclose = () => {
      if (checkWebsocket()) {
        logMessage(LOG, 'WebSocket onclose')
        this.stepStateMachine('CONNECTION_CLOSED')
      }
    }

    this.websocket.onerror = () => {
      if (checkWebsocket()) {
        logMessage(LOG, 'WebSocket onerror')
        this.stepStateMachine('CONNECTION_ERROR')
      }
    }
  }

  private setConnectionTimeout(): void {
    const localWebsocket = this.websocket

    this.connectionTimeoutId = window.setTimeout(() => {
      if (localWebsocket !== this.websocket) {
        return
      }

      if (this.websocket == null) {
        // This should never happen! The only place we call
        // setConnectionTimeout() should be immediately before setting
        // this.websocket.
        this.stepStateMachine('CONNECTION_WTF')
        return
      }

      if (this.websocket.readyState === 0 /* CONNECTING */) {
        logError(LOG, `${this.uriList[this.uriIndex]} timed out`)
        this.stepStateMachine('CONNECTION_TIMED_OUT')
      }
    }, CONNECTION_ATTEMPT_TIMEOUT_MS)
  }

  /**
   * Encodes the message with the outgoingMessageType and sends it over the
   * wire.
   */
  public sendMessage(obj: IBackMsg): void {
    if (!this.websocket) {
      return
    }
    const msg = BackMsg.create(obj)
    const buffer = BackMsg.encode(msg).finish()
    this.websocket.send(buffer)
  }

  private handleMessage(data: any): void {
    // Assign this message an index.
    const messageIndex = this.nextMessageIndex
    this.nextMessageIndex += 1

    // Read in the message data.
    const reader = new FileReader()
    reader.readAsArrayBuffer(data)
    reader.onloadend = () => {
      if (this.messageQueue == null) {
        logError(LOG, 'No message queue.')
        return
      }

      const result = reader.result
      if (result == null || typeof result === 'string') {
        logError(LOG, `Unexpected result from FileReader: ${result}.`)
        return
      }

      const resultArray = new Uint8Array(result)
      this.messageQueue[messageIndex] = ForwardMsg.decode(resultArray)
      while ((this.lastDispatchedMessageIndex + 1) in this.messageQueue) {
        const dispatchMessageIndex = this.lastDispatchedMessageIndex + 1
        this.onMessage(this.messageQueue[dispatchMessageIndex])
        delete this.messageQueue[dispatchMessageIndex]
        this.lastDispatchedMessageIndex = dispatchMessageIndex
      }
    }
  }
}