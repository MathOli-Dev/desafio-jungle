import { spawn, ChildProcess } from 'node:child_process';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'node:net';
import { createApp } from '@/app.module';
import { loadConfig } from '@/config/config';

export interface TestApp {
  app: NestExpressApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/** Sobe a aplicação Nest real (todos os módulos/providers) dentro do processo de teste, em porta efêmera. */
export async function startApp(env: Record<string, string>): Promise<TestApp> {
  const app = await createApp(loadConfig(env));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface Instance {
  name: string;
  proc: ChildProcess;
  baseUrl?: string;
  logs: string[];
  exited: Promise<number | null>;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

/**
 * Sobe um PROCESSO real (`bun src/main.ts`): instâncias independentes, cada uma com seu pool, seus workers e sua
 * memória — a única forma honesta de provar correção com N instâncias.
 */
export async function spawnInstance(name: string, env: Record<string, string>): Promise<Instance> {
  const proc = spawn('bun', ['src/main.ts'], { cwd: process.cwd(), env: { ...process.env, LOG_LEVEL: 'info', ...env, INSTANCE_ID: name }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  let baseUrl: string | undefined;
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      logs.push(line);
      if (logs.length > 500) logs.shift();
      const m = line.match(/"message":"http listening","port":(\d+)/);
      if (m) baseUrl = `http://127.0.0.1:${m[1]}`;
    }
  };
  proc.stdout!.on('data', onData);
  proc.stderr!.on('data', onData);
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  const inst: Instance = {
    name, proc, logs, exited,
    get baseUrl() { return baseUrl; },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      return Promise.race([exited, new Promise<null>((r) => setTimeout(() => { proc.kill('SIGKILL'); r(null); }, 20_000))]);
    },
  } as Instance;
  // espera ficar pronto (HTTP escutando ou workers iniciados)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (logs.some((l) => l.includes('"message":"service started"'))) return inst;
    if (proc.exitCode !== null) throw new Error(`instance ${name} exited early (${proc.exitCode}):\n${logs.join('\n')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`instance ${name} did not start:\n${logs.join('\n')}`);
}
