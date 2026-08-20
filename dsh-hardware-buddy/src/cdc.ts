import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import type { Config } from './config.js';
import type { DeviceCommand, Heartbeat } from './protocol.js';

export interface CdcLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug: (m: string) => void;
}

/**
 * USB CDC (SerialPort) bridge to the StickS3.
 *
 * Lifecycle is owned by the caller via ctx.effect -> stop(). Connection loss is
 * tolerated: send() silently drops when not connected, and a 5s poll tries to
 * reconnect so a re-plug auto-recovers the heartbeat.
 */
export class CdcBridge {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private connected = false;
  private shouldRun = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: Config,
    private readonly onCommand: (cmd: DeviceCommand) => void,
    private readonly onConnectionChange: (connected: boolean) => void,
    private readonly logger: CdcLogger,
  ) {}

  async start(): Promise<void> {
    this.shouldRun = true;
    await this.tryConnect();
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const port = this.port;
    this.port = null;
    this.parser = null;
    this.connected = false;
    if (port && port.isOpen) {
      await new Promise<void>((resolve) => port.close(() => resolve()));
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Write a heartbeat. Returns false (silent drop) when not connected. */
  send(hb: Heartbeat): boolean {
    if (!this.connected || !this.port?.isOpen) return false;
    try {
      const ok = this.port.write(JSON.stringify(hb) + '\n');
      return ok !== false;
    } catch {
      // write can throw if the handle is mid-teardown; never crash the plugin
      return false;
    }
  }

  private async tryConnect(): Promise<void> {
    if (!this.shouldRun) return;
    let path: string | undefined;
    try {
      path = this.config.port ?? (await this.discoverPort());
    } catch (err) {
      this.logger.warn(`port discovery failed: ${(err as Error).message}`);
    }

    if (!path) {
      this.logger.warn('No StickS3 CDC port found, retry in 5s');
      this.scheduleReconnect();
      return;
    }

    try {
      const port = new SerialPort({ path, baudRate: this.config.baudRate, autoOpen: false });
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n', encoding: 'utf8' }));

      port.on('open', () => {
        this.connected = true;
        this.onConnectionChange(true);
        this.logger.info(`CDC connected on ${path}`);
      });
      port.on('close', () => {
        if (this.connected) this.onConnectionChange(false);
        this.connected = false;
        this.logger.warn(`CDC disconnected from ${path}`);
        if (this.shouldRun) this.scheduleReconnect();
      });
      port.on('error', (err) => this.logger.error(`CDC error: ${err.message}`));

      parser.on('data', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          this.onCommand(JSON.parse(trimmed) as DeviceCommand);
        } catch {
          this.logger.warn(`Failed to parse device line: ${trimmed.slice(0, 80)}`);
        }
      });

      await new Promise<void>((resolve, reject) =>
        port.open((err) => (err ? reject(err) : resolve())),
      );

      this.port = port;
      this.parser = parser;
    } catch (err) {
      this.logger.error(`Failed to open ${path}: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldRun) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect();
    }, 5000);
  }

  /**
   * Discover the StickS3 port. Primary: match by USB VID (optionally PID).
   * Fallback: name match for /dev/cu.usbmodem* (macOS) or /dev/ttyACM* (Linux),
   * since the VID may be absent on some platforms / serialport builds.
   */
  private async discoverPort(): Promise<string | undefined> {
    const ports = await SerialPort.list();
    const wantVid = this.config.vendorId.toLowerCase();
    const wantPid = this.config.productId?.toLowerCase();

    const byVid = ports.find((p) => {
      if (!p.vendorId || p.vendorId.toLowerCase() !== wantVid) return false;
      return !wantPid || p.productId?.toLowerCase() === wantPid;
    });
    if (byVid) return byVid.path;

    return ports.find((p) => /usbmodem|ttyacm/i.test(p.path))?.path;
  }
}
