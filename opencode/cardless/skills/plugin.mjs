
import { fileURLToPath } from 'node:url';

// Register the bundled skills when installed through OpenCode's plugin routes.
export const CaptainPlugin = async () => ({
  config(config) {
    const skillsPath = fileURLToPath(new URL('./', import.meta.url));
    config.skills ??= {};
    config.skills.paths ??= [];
    if (!config.skills.paths.includes(skillsPath)) {
      config.skills.paths.push(skillsPath);
    }
  }
});
