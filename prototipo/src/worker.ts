// Entrypoint de worker separado: `npm run worker` sobe mais um consumidor das filas.
// Serve para demonstrar que o rate limit de 600 rps do RF6 e global (Redis), nao por processo.
import { iniciarWorkers } from './workers.ts';

const parar = iniciarWorkers();
const desligar = async () => {
  await parar();
  process.exit(0);
};
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);
