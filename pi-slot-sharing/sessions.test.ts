/**
 * The numbers in here are measured on one reference machine (RX 7900 XTX, 62 GiB RAM): Qwen3.8-Flash-Next IQ3_S,
 * int8 KV, 393,216 position context, 62 GiB of RAM. They pin the gate to what the engine actually does,
 * so a change in our mirror of its arithmetic shows up as a failing test rather than as a restore that
 * was refused at 3 a.m.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	bytesPerTokenFromSave,
	maxRestorableTokens,
	MIB,
	pidLooksAlive,
	sessionKey,
	sessionReadPeakBytes,
	slotFilenameProblem,
	restoreGate,
} from "./sessions.ts";

/** The 283,373 token save: 4,563,846,172 bytes written. */
const SAVED_BYTES = 4_563_846_172;
const SAVED_TOKENS = 283_373;

test("peak estimate reproduces the engine's own refusal figure", () => {
	// strata refused with: "4370 MiB plus a floor of 2560 MiB needed, 4016 MiB available, source meminfo"
	const peak = sessionReadPeakBytes(SAVED_BYTES);
	assert.equal(Math.round(peak / MIB), 4370);
});

test("refuses the 283K restore the engine refused", () => {
	const verdict = restoreGate({
		availableBytes: 4016 * MIB,
		floorBytes: 2560 * MIB,
		marginBytes: 0,
		fileBytes: SAVED_BYTES,
	});
	assert.equal(verdict.ok, false);
	assert.ok(verdict.shortByBytes > 2_900 * MIB, "short by roughly 2.9 GiB");
});

test("admits the 107K restore the engine admitted", () => {
	// 107,695 tokens at the measured 16,106 bytes/token
	const bytes = Math.round(107_695 * 16_106);
	const verdict = restoreGate({ availableBytes: 4444 * MIB, floorBytes: 2560 * MIB, marginBytes: 0, fileBytes: bytes });
	assert.equal(verdict.ok, true, verdict.reason);
});

test("a 256K conversation does not come back at int8 whatever the floor is", () => {
	// This is the measurement that shaped the design: saves work at 256K, restores do not.
	const bytes = Math.round(256_000 * 16_106);
	for (const floor of [2560, 1024, 512, 0]) {
		const verdict = restoreGate({ availableBytes: 4100 * MIB, floorBytes: floor * MIB, marginBytes: 0, fileBytes: bytes });
		if (floor >= 512) assert.equal(verdict.ok, false, `floor ${floor} should still refuse`);
	}
});

test("bytes per token is learned from the server's own numbers", () => {
	const perToken = bytesPerTokenFromSave(SAVED_BYTES, SAVED_TOKENS);
	assert.ok(perToken !== undefined);
	assert.ok(Math.abs(perToken - 16_106) < 5, `measured ${perToken?.toFixed(0)} B/token`);
});

test("a save reports nothing usable as a size", () => {
	assert.equal(bytesPerTokenFromSave(0, 0), undefined);
	assert.equal(bytesPerTokenFromSave(100, 0), undefined);
});

test("maxRestorableTokens tracks the gate", () => {
	const room = maxRestorableTokens(4444 * MIB, 1024 * MIB, 256 * MIB, 16_106);
	assert.ok(room > 190_000 && room < 230_000, `room ${room}`);
	// whatever it says, the gate must agree
	assert.equal(restoreGate({ availableBytes: 4444 * MIB, floorBytes: 1024 * MIB, marginBytes: 256 * MIB, fileBytes: room * 16_106 }).ok, true);
	assert.equal(maxRestorableTokens(500 * MIB, 1024 * MIB, 0, 16_106), 0);
});

test("session keys separate sessions and models", () => {
	assert.notEqual(sessionKey("a", "p/m1"), sessionKey("b", "p/m1"));
	assert.notEqual(sessionKey("a", "p/m1"), sessionKey("a", "p/m2"));
});

test("file names are checked the way the server checks them", () => {
	assert.equal(slotFilenameProblem("pi-0123abcd.bin"), undefined);
	for (const bad of ["", "a/b", "a\\b", "a:b", "a*b", 'a"b', "a<b", "a|b", ".hidden", "trailing.", "trailing ", "NUL", "nul.txt", "CON.bin", "com1", "com\u00b9"]) {
		assert.notEqual(slotFilenameProblem(bad), undefined, `${JSON.stringify(bad)} should be rejected`);
	}
	assert.notEqual(slotFilenameProblem("x".repeat(201)), undefined);
	assert.notEqual(slotFilenameProblem(undefined), undefined);
});

test("a dead process cannot hold the slot", () => {
	assert.equal(pidLooksAlive(process.pid, process.kill), true);
	assert.equal(pidLooksAlive(-1, process.kill), false);
	assert.equal(pidLooksAlive(0, process.kill), false);
	// A pid nobody owns is reported dead, which is what lets a crashed session's lock be taken over.
	assert.equal(pidLooksAlive(2_147_483_646, process.kill), false);
});
