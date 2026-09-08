/** Owns a verification process group. Broker stdin is a lifetime lease:
 * when the broker dies (including SIGKILL), EOF kills this entire group.
 * Launched only by runVerification, in a detached group on POSIX.
 */
const argv = process.argv.slice(2);
if (!argv.length) process.exit(2);
const terminate = () => {
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  }
  child.kill('SIGKILL');
  process.exit(125);
};
const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
void (async () => { for await (const _ of Bun.stdin.stream()) { /* hold lease */ } terminate(); })();
const code = await child.exited;
// Parent records this code and cleans up any remaining group descendants.
process.exit(code);
