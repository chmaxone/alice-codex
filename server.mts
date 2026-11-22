import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

interface AliceRequest {
  version?: unknown;
  session?: {
    skill_id?: unknown;
    session_id?: unknown;
    message_id?: unknown;
    user?: { user_id?: unknown };
    application?: { application_id?: unknown };
  };
  request?: {
    type?: unknown;
    command?: unknown;
    original_utterance?: unknown;
  };
}

interface Job {
  id: string;
  question: string;
  result?: { text: string; success: boolean; finishedAt: number };
}

const token = readFileSync('webhook-token', 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid webhook token');
const route = Buffer.from('/alice-codex/' + token);
const jobs = new Map<string, Job>();
let running = 0;

function reply(res: http.ServerResponse, text: string, end_session = false) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ version: '1.0', response: { text, end_session } }));
}

function start(owner: string, id: string, question: string) {
  const startedAt = performance.now();
  const current: Job = { id, question };
  const child = spawn(process.env.CODEX_BIN ?? 'codex', [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
    '--ignore-user-config', '--ignore-rules', '--ephemeral', '--color', 'never', '-',
  ], { timeout: 90000, killSignal: 'SIGKILL' });
  jobs.set(owner, current);
  running++;
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output = (output + chunk).slice(0, 8000); });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', (error: NodeJS.ErrnoException) => console.error('Could not start Codex:', error.code));
  child.once('close', (code, signal) => {
    running--;
    const success = code === 0 && Boolean(output.trim());
    const text = success
      ? output.trim().replaceAll(/[*#`]/g, '').replaceAll(/\s+/g, ' ').slice(0, 900)
      : 'Кодекс не смог ответить. Попробуйте задать вопрос ещё раз.';
    current.result = { text, success, finishedAt: Date.now() };
    console.log('Codex completed:', code, signal, Math.round(performance.now() - startedAt), 'ms');
  });
  child.stdin.end('Ответь кратко по-русски, обычным текстом для озвучивания, максимум 600 символов. Не используй инструменты и локальные данные. Вопрос пользователя:\n' + question);
}

const server = http.createServer(async (req, res) => {
  const path = Buffer.from(req.url ?? '');
  if (req.method !== 'POST' || path.length !== route.length || !timingSafeEqual(path, route)) {
    res.writeHead(404).end();
    return;
  }
  const receivedAt = performance.now();
  res.once('finish', () => {
    console.log('Webhook response:', res.statusCode, Math.round(performance.now() - receivedAt), 'ms');
  });
  try {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32768) {
        res.writeHead(413).end();
        return;
      }
    }
    const { version, session, request } = JSON.parse(body) as AliceRequest;
    const user = session?.user?.user_id || session?.application?.application_id;
    if (version !== '1.0' || typeof user !== 'string' || !user ||
        typeof session?.skill_id !== 'string' || !session.skill_id ||
        typeof session.session_id !== 'string' || !session.session_id ||
        !Number.isInteger(session.message_id)) {
      res.writeHead(400).end();
      return;
    }
    const owner = session.skill_id + '/' + user;
    const id = session.session_id + '/' + session.message_id;
    const utterance = request?.command ?? request?.original_utterance ?? '';
    if (typeof utterance !== 'string') {
      res.writeHead(400).end();
      return;
    }
    const phrase = utterance.trim();
    const command = phrase.toLowerCase().replace(/[.!?,]+$/u, '');
    if (/^(выход|выйти|закрой навык|стоп|хватит)$/u.test(command)) {
      return reply(res, 'До встречи!', true);
    }
    if (!command || /^(помощь|что ты умеешь|запусти навык джарвис помощник)$/u.test(command)) {
      return reply(res, 'Задайте вопрос. Если я ещё готовлю ответ, скажите «Ответ» или повторите вопрос.');
    }
    for (const [key, previous] of jobs) {
      if (previous.result && Date.now() - previous.result.finishedAt > 15 * 60_000) jobs.delete(key);
    }
    const job = jobs.get(owner);
    if (/^(что (?:ответил|сказал) (?:кодекс|код икс)|ответ|результат|(?:прочитай|скажи|дай|озвучь) (?:мне )?ответ|готов(?:о| ли)|статус)$/u.test(command)) {
      if (!job) return reply(res, 'Сначала задайте вопрос.');
      return reply(res, job.result?.text ?? 'Кодекс ещё работает.');
    }
    if (request?.type !== 'SimpleUtterance') return reply(res, 'Задайте вопрос голосом.');
    const accepted = 'Готовлю ответ. Через несколько секунд скажите «Ответ» или повторите вопрос.';
    const question = phrase.replace(/^(?:спроси кодекс(?:а)?|вопрос кодексу)[\s,:]+/iu, '').slice(0, 2000);
    if (job?.id === id) return reply(res, job.result?.text ?? accepted);
    if (job?.question === question) {
      if (!job.result) return reply(res, 'Ещё готовлю ответ.');
      if (job.result.success && Date.now() - job.result.finishedAt < 45_000) return reply(res, job.result.text);
    }
    if (job && !job.result) return reply(res, 'Ваш предыдущий вопрос ещё обрабатывается. Чтобы проверить, скажите «Ответ».');
    if (running >= 2) return reply(res, 'Кодекс сейчас обрабатывает другие вопросы. Повторите свой вопрос чуть позже.');
    start(owner, id, question);
    return reply(res, accepted);
  } catch {
    res.writeHead(400).end();
  }
});
server.listen(8796, '127.0.0.1');
