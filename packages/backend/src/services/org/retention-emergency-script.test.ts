import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RETENTION_TABLE_TTL_DAYS } from "@maple/domain/http"

const script = fileURLToPath(new URL("../../../../../deploy/docker/scripts/retention-emergency.sh", import.meta.url))

describe("retention-emergency.sh", () => {
	it("is executable, as the docs run it directly", () => {
		expect(statSync(script).mode & 0o111).not.toBe(0)
	})

	it("drops from the same raw tables as the sweep", () => {
		const tables = execFileSync("bash", [script, "tables"], { encoding: "utf8" }).split("\n").filter(Boolean)
		expect(tables.sort()).toEqual(Object.keys(RETENTION_TABLE_TTL_DAYS).sort())
	})

	it("retries a drop the server refuses for size with the setting lifted", () => {
		const dir = mkdtempSync(join(tmpdir(), "retention-"))
		try {
			mkdirSync(join(dir, "scripts"))
			mkdirSync(join(dir, "bin"))
			copyFileSync(script, join(dir, "scripts/retention-emergency.sh"))
			writeFileSync(join(dir, ".env"), "CLICKHOUSE_ADMIN_PASSWORD=x\n")
			// A fake `docker compose exec ... clickhouse-client`: one old partition, and the error text a real
			// ClickHouse 25.8 gives (it names max_[table/partition]_size_to_drop, never the bare setting).
			writeFileSync(
				join(dir, "bin/docker"),
				`#!/usr/bin/env bash
args="$*"
case $args in
	*"DROP PARTITION"*)
		echo "$args" >>"${dir}/calls"
		[[ $args == *--max_partition_size_to_drop=0* ]] && exit 0
		echo "Code: 359. DB::Exception: Size (103.67 KB) is greater than max_[table/partition]_size_to_drop (1.00 KB). (TABLE_SIZE_EXCEEDS_MAX_DROP_SIZE_LIMIT)" >&2
		exit 1 ;;
	*"partition_id"*) printf 'org_aaa\ttraces\t20200101\t100\n' ;;
	*) echo 1 ;;
esac
`,
			)
			chmodSync(join(dir, "bin/docker"), 0o755)
			const out = execFileSync("bash", [join(dir, "scripts/retention-emergency.sh"), "free", "--keep-days", "7", "--yes"], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
				stdio: ["ignore", "pipe", "pipe"],
			})
			expect(out).toContain("dropping org_aaa.traces 20200101")
			const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n")
			expect(calls).toHaveLength(2)
			expect(calls[0]).not.toContain("--max_partition_size_to_drop=0")
			expect(calls[1]).toContain("--max_partition_size_to_drop=0")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
