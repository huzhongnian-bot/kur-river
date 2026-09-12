import { stopInfra } from './infra';

export default async function globalTeardown() {
  await stopInfra();
}
