import { startInfra } from './infra';

export default async function globalSetup() {
  await startInfra();
}
