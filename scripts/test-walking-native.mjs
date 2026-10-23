import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = mkdtempSync(resolve(tmpdir(), 'aiss-walking-test-'));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
};
try {
  run('javac', ['-d', output,
    resolve(root, 'android/app/src/main/java/in/aismartstick/app/WalkingAccumulator.java'),
    resolve(root, 'android/app/src/test/java/in/aismartstick/app/WalkingAccumulatorTest.java'),
  ]);
  run('java', ['-cp', output, 'in.aismartstick.app.WalkingAccumulatorTest']);
} finally {
  rmSync(output, { recursive: true, force: true });
}
