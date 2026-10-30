// Imported first by every test file: isolated data and forced simulation — tests never touch real data or the API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arm-test-"));
process.env.ARM_DATA_DIR = path.join(TMP, "data");
process.env.ARM_DISABLE_DOTENV = "1";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
// Without a key the backend falls back to the Claude plan; keep that off so no test starts a real `claude` process.
process.env.ARM_DISABLE_SUBSCRIPTION = "1";

/** A file:// URL for a local path that git accepts on every platform (file:///C:/… on Windows, file:///tmp/… elsewhere). */
export const fileUrl = (p: string) => pathToFileURL(p).href;

export const FIXTURE_PDF =path.resolve(import.meta.dirname, "fixtures/field-service-requirements.pdf");
