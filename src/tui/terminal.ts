/**
 * 终端抽象（设计 §12.2、§12.3、§12.8）。[B4]
 *
 * - `Terminal`：TUI 只依赖这个接口——尺寸、写入、输入回调、尺寸变化回调。
 * - `ProcessTerminal`：真实 TTY。raw 模式、括号粘贴 `?2004`、增强键盘上报（Ctrl+Enter 可区分）、stdout `resize`（SIGWINCH）；
 *   输入经 `StdinBuffer` 切分，括号粘贴以 `ESC[200~正文ESC[201~` 一次交给 onInput。
 *   停止时关括号粘贴、显示光标、恢复 cooked 模式；**不清屏**（回滚保留对话）。
 * - `MemoryTerminal`：测试用。记录每次写入，并用 `VirtualScreen` 还原屏幕与回滚。
 */

import { PASTE_END, PASTE_START } from "./keys.js";
import { StdinBuffer } from "./stdin-buffer.js";
import { VirtualScreen } from "./vt-screen.js";

export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  /** 进入 raw 模式、开括号粘贴、开始投递输入与尺寸变化。 */
  start(onInput: (data: string) => void, onResize: () => void): void;
  /** 关括号粘贴、恢复 cooked 模式、停止投递；不清屏。 */
  stop(): void;
  write(data: string): void;
}

export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
/**
 * 增强键盘上报（只写不查，没有回包）：kitty 键盘协议 disambiguate 标志（入栈 `CSI > 1 u`，出栈 `CSI < u`）与 xterm
 * modifyOtherKeys 级别 1（`CSI > 4;1 m`，复位 `CSI > 4 m`）。用来让终端把 Ctrl+Enter 发成 `ESC[13;5u` /
 * `ESC[27;5;13~`，不然它和 Enter 同为 `\r`。不支持的终端忽略这两条；tmux 只在 `extended-keys` 开着时转发。
 */
export const KEYBOARD_ENHANCE_ON = "\x1b[>1u\x1b[>4;1m";
export const KEYBOARD_ENHANCE_OFF = "\x1b[<u\x1b[>4m";
export const SHOW_CURSOR = "\x1b[?25h";
export const HIDE_CURSOR = "\x1b[?25l";

export interface ProcessTerminalOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  escTimeoutMs?: number;
  /** 开增强键盘上报；缺省开，环境变量 `AMA_KEYBOARD_PROTOCOL=off` 关。 */
  enhancedKeys?: boolean;
}

export class ProcessTerminal implements Terminal {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly escTimeoutMs: number | undefined;
  private readonly enhancedKeys: boolean;
  private buffer: StdinBuffer | null = null;
  private wasRaw = false;
  private dataListener: ((chunk: Buffer | string) => void) | null = null;
  private resizeListener: (() => void) | null = null;

  constructor(options: ProcessTerminalOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.escTimeoutMs = options.escTimeoutMs;
    this.enhancedKeys =
      options.enhancedKeys ?? process.env["AMA_KEYBOARD_PROTOCOL"]?.toLowerCase() !== "off";
  }

  get columns(): number {
    return this.stdout.columns || 80;
  }

  get rows(): number {
    return this.stdout.rows || 24;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    const bufferOptions = {
      onData: onInput,
      onPaste: (text: string) => onInput(PASTE_START + text + PASTE_END),
    };
    this.buffer = new StdinBuffer(
      this.escTimeoutMs === undefined
        ? bufferOptions
        : { ...bufferOptions, escTimeoutMs: this.escTimeoutMs },
    );
    if (this.stdin.isTTY) {
      this.wasRaw = this.stdin.isRaw;
      this.stdin.setRawMode(true);
    }
    this.stdin.setEncoding("utf8");
    const buffer = this.buffer;
    this.dataListener = (chunk) => buffer.process(chunk);
    this.stdin.on("data", this.dataListener);
    this.stdin.resume();
    this.resizeListener = onResize;
    this.stdout.on("resize", this.resizeListener);
    this.write(BRACKETED_PASTE_ON + (this.enhancedKeys ? KEYBOARD_ENHANCE_ON : ""));
  }

  stop(): void {
    if (this.buffer === null) return;
    this.buffer.flush();
    this.buffer.destroy();
    this.buffer = null;
    this.write((this.enhancedKeys ? KEYBOARD_ENHANCE_OFF : "") + BRACKETED_PASTE_OFF + SHOW_CURSOR);
    if (this.dataListener) this.stdin.off("data", this.dataListener);
    if (this.resizeListener) this.stdout.off("resize", this.resizeListener);
    this.dataListener = null;
    this.resizeListener = null;
    if (this.stdin.isTTY) this.stdin.setRawMode(this.wasRaw);
    this.stdin.pause();
  }

  write(data: string): void {
    this.stdout.write(data);
  }
}

export interface MemoryTerminalOptions {
  columns?: number;
  rows?: number;
  /** 测试里孤立 ESC 的超时；缺省 10 ms。 */
  escTimeoutMs?: number;
}

export class MemoryTerminal implements Terminal {
  readonly screen: VirtualScreen;
  /** 每次 write 的原始数据（按顺序）。 */
  readonly writes: string[] = [];
  started = false;
  rawMode = false;
  private onInput: ((data: string) => void) | null = null;
  private onResize: (() => void) | null = null;
  private buffer: StdinBuffer;

  constructor(options: MemoryTerminalOptions = {}) {
    this.screen = new VirtualScreen(options.columns ?? 80, options.rows ?? 24);
    this.buffer = new StdinBuffer({
      onData: (data) => this.onInput?.(data),
      onPaste: (text) => this.onInput?.(PASTE_START + text + PASTE_END),
      escTimeoutMs: options.escTimeoutMs ?? 10,
    });
  }

  get columns(): number {
    return this.screen.columns;
  }

  get rows(): number {
    return this.screen.height;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
    this.started = true;
    this.rawMode = true;
    this.write(BRACKETED_PASTE_ON);
  }

  stop(): void {
    if (!this.started) return;
    this.buffer.flush();
    this.write(BRACKETED_PASTE_OFF + SHOW_CURSOR);
    this.started = false;
    this.rawMode = false;
    this.onInput = null;
    this.onResize = null;
  }

  write(data: string): void {
    this.writes.push(data);
    this.screen.write(data);
  }

  /** 模拟一个 stdin data 块（经 StdinBuffer 切分，与真实终端同路径）。 */
  sendInput(chunk: string): void {
    this.buffer.process(chunk);
  }

  /** 立即发出挂起的不完整序列（替代等待 ESC 超时）。 */
  flushInput(): void {
    this.buffer.flush();
  }

  /** 改尺寸并触发 resize 回调（模拟 SIGWINCH）。 */
  resize(columns: number, rows: number): void {
    this.screen.resize(columns, rows);
    this.onResize?.();
  }

  /** 全部写入拼成一个字符串。 */
  get output(): string {
    return this.writes.join("");
  }

  /** 取走并清空写入记录（便于断言「这一帧写了什么」）。 */
  takeWrites(): string {
    const out = this.writes.join("");
    this.writes.length = 0;
    return out;
  }

  /** 可见屏幕各行（去掉右侧空白）。 */
  viewport(): string[] {
    return this.screen.viewport();
  }

  /** 回滚 + 屏幕（去掉底部空行）。 */
  transcript(): string[] {
    return this.screen.transcript();
  }
}
