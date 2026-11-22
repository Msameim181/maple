import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RETENTION_TABLE_TTL_DAYS } from "@maple/domain/http"

const script = fileURLToPath(new URL("../../../../../deploy/docker/scripts/retention-emergency.sh", import.meta.url))

describe("retention-emergency.sh", () => {
	it("drops from the same raw tables as the sweep", () => {
		const tables = execFileSync("bash", [script, "tables"], { encoding: "utf8" }).split("\n").filter(Boolean)
		expect(tables.sort()).toEqual(Object.keys(RETENTION_TABLE_TTL_DAYS).sort())
	})
})
