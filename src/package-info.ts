import { readFileSync } from 'node:fs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string; version: string;
};

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;

/** 明確指定套件與版本，避免 npx 推測錯誤的執行檔或使用不同版本。 */
export function loginCommand(ticket: string, sshTarget?: string): string {
  return `npx --yes ${PACKAGE_NAME}@${PACKAGE_VERSION} login${sshTarget ? ` --ssh ${sshTarget}` : ''} --ticket ${ticket}`;
}
