import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const defaultSystemPrompt = 'Отвечай кратко по-русски, обычным текстом для озвучивания, максимум 600 символов. Для актуальных сведений или по просьбе пользователя используй встроенный веб-поиск и назови источники простыми словами. Не используй локальные файлы, команды и другие инструменты.';

interface Message {
  id?: number;
  method?: string;
  error?: { message: string };
  result?: { thread?: { id: string } };
  params?: {
    threadId?: string;
    item?: { type: string; text?: string };
    turn?: { status: string };
  };
}

interface Turn {
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export class CodexSession {
  readonly #process = spawn(process.env.CODEX_BIN ?? 'codex', ['app-server', '--listen', 'stdio://'], {
    cwd: '/tmp',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  readonly #rpc = new Map<number, {
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  }>();
  readonly #turns = new Map<string, Turn>();
  readonly #threads = new Map<string, string>();
  readonly #ready: Promise<void>;
  #nextId = 0;
  #closed = false;

  constructor() {
    this.#process.stderr.resume();
    this.#process.on('error', error => this.#close(error));
    this.#process.stdin.on('error', error => this.#close(error));
    this.#process.on('close', () => this.#close(new Error('Codex App Server exited')));
    createInterface({ input: this.#process.stdout }).on('line', line => {
      try {
        this.#receive(JSON.parse(line) as Message);
      } catch {
        this.#close(new Error('Invalid Codex App Server message'));
      }
    });
    this.#ready = this.#request('initialize', {
      clientInfo: { name: 'alice-codex', version: '1.0.0' },
    }).then(() => {
      this.#send({ method: 'initialized' });
    });
    // The first turn consumes this promise, including any startup failure.
    void this.#ready.catch(() => {});
  }

  get closed() {
    return this.#closed;
  }

  hasThread(owner: string) {
    return this.#threads.has(owner);
  }

  async ask(owner: string, question: string): Promise<string> {
    const timer = setTimeout(() => this.#close(new Error('Codex turn timed out')), 90_000);
    try {
      await this.#ready;
      let threadId = this.#threads.get(owner);
      if (!threadId) {
        const reply = await this.#request('thread/start', {
          cwd: '/tmp',
          ephemeral: true,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          config: { mcp_servers: {}, web_search: 'live' },
          developerInstructions: process.env.CODEX_SYSTEM_PROMPT ?? defaultSystemPrompt,
        });
        threadId = reply.result?.thread?.id;
        if (!threadId) throw new Error('Codex did not create a thread');
        this.#threads.set(owner, threadId);
      }

      const id = threadId;
      return await new Promise<string>((resolve, reject) => {
        this.#turns.set(id, { text: '', resolve, reject });
        void this.#request('turn/start', {
          threadId: id,
          input: [{ type: 'text', text: question, text_elements: [] }],
        }).catch(error => {
          this.#turns.delete(id);
          reject(error);
        });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #send(message: object) {
    if (this.#closed) throw new Error('Codex App Server is unavailable');
    this.#process.stdin.write(JSON.stringify(message) + '\n');
  }

  #request(method: string, params: object): Promise<Message> {
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      if (this.#closed) {
        reject(new Error('Codex App Server is unavailable'));
        return;
      }
      this.#rpc.set(id, { resolve, reject });
      this.#send({ id, method, params });
    });
  }

  #receive(message: Message) {
    if (message.id !== undefined) {
      if (message.method) {
        this.#send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } });
        return;
      }
      const request = this.#rpc.get(message.id);
      this.#rpc.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message);
      return;
    }
    const id = message.params?.threadId;
    if (!id) return;
    const turn = this.#turns.get(id);
    if (!turn) return;
    const item = message.params?.item;
    if (message.method === 'item/completed' && item?.type === 'webSearch') {
      console.log('Codex web search completed');
    }
    if (message.method === 'item/completed' && item?.type === 'agentMessage' && item.text) {
      turn.text = item.text;
    }
    if (message.method === 'turn/completed') {
      this.#turns.delete(id);
      if (message.params?.turn?.status === 'completed' && turn.text) turn.resolve(turn.text);
      else turn.reject(new Error('Codex did not complete the turn'));
    }
  }

  #close(error: Error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#process.kill();
    for (const request of this.#rpc.values()) request.reject(error);
    for (const turn of this.#turns.values()) turn.reject(error);
    this.#rpc.clear();
    this.#turns.clear();
    this.#threads.clear();
  }
}
