import 'reflect-metadata';
import { AddressInfo } from 'node:net';
import { createApp } from './app.module';
import { loadConfig } from './config/config';

/** Banner de startup: sempre emitido (independe do LOG_LEVEL) para orquestradores/testes detectarem prontidão e porta. */
const announce = (message: string, fields: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message, ...fields })}\n`);
};

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);

  if (config.run.http) {
    await app.listen(config.port, '0.0.0.0');
    // keep-alive maior que o idle timeout típico de balanceadores (ALB: 60s): evita resets de conexões reutilizadas
    const server = app.getHttpServer();
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    const { port } = app.getHttpServer().address() as AddressInfo;
    announce('http listening', { port, instanceId: config.instanceId });
  } else {
    await app.init(); // modo "workers only": sem porta HTTP
    announce('workers started without http', { instanceId: config.instanceId });
  }
  announce('service started', {
    instanceId: config.instanceId,
    consumer: config.run.consumer, outboxPublisher: config.run.outboxPublisher, pendingReferenceWorker: config.run.pendingReferenceWorker,
  });
}

bootstrap().catch((error) => {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', message: 'bootstrap failed', error: String(error), stack: error?.stack })}\n`);
  process.exit(1);
});
