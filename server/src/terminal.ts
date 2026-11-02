/** Opens a terminal window on this computer, in a folder, optionally running a command — for the person at the
 *  computer (AgentStudio runs locally). Returns false on a platform where no terminal is known. */
import { spawn } from "node:child_process";

export function openTerminal(dir: string, o: { title?: string; command?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const env = o.env ?? process.env;
  if (process.platform === "win32") {
    // `start "title" /D dir cmd /k [command]`: a new window in the folder that stays open.
    spawn("cmd.exe", ["/c", "start", o.title ?? "AgentStudio", "/D", dir, "cmd.exe", "/k", ...(o.command ? [o.command] : [])], { env, detached: true, stdio: "ignore", windowsHide: false }).unref();
    return true;
  }
  if (process.platform === "darwin") {
    const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const line = `cd '${dir.replace(/'/g, "'\\''")}'${o.command ? `; ${o.command}` : ""}`;
    spawn("osascript", ["-e", `tell application "Terminal" to do script "${quote(line)}"`, "-e", 'tell application "Terminal" to activate'], { env, detached: true, stdio: "ignore" }).unref();
    return true;
  }
  for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    try {
      spawn(term, [], { cwd: dir, env, detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
      return true;
    } catch {
      /* try the next one */
    }
  }
  return false;
}
