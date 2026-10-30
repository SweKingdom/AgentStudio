// Imported first by every test file: isolated data and forced simulation — tests never touch real data or the API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "arm-test-"));
process.env.ARM_DATA_DIR = path.join(TMP, "data");
process.env.ARM_DISABLE_DOTENV = "1";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

export const FIXTURE_PDF = path.resolve(import.meta.dirname, "fixtures/field-service-requirements.pdf");
