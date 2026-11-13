import { expect } from "chai";
// @ts-ignore
const { validateProgramId, runFreeze } = require("../scripts/freeze-program.js");

describe("TASK 02 — Freeze Program Script Security", () => {
  const VALID_PUBKEY = "26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC";

  it("accepts a valid base58 public key", () => {
    const validated = validateProgramId(VALID_PUBKEY);
    expect(validated).to.equal(VALID_PUBKEY);
  });

  it("rejects shell metacharacters and injection attempts", () => {
    const maliciousInputs = [
      `${VALID_PUBKEY}; rm -rf /`,
      `${VALID_PUBKEY} && echo hacked`,
      `${VALID_PUBKEY} | whoami`,
      "`calc.exe`",
      `$(${VALID_PUBKEY})`,
      `${VALID_PUBKEY} > /tmp/out`,
      `${VALID_PUBKEY} < /etc/passwd`,
      "invalid-not-base58-key",
      "123",
      "",
    ];

    for (const input of maliciousInputs) {
      expect(() => validateProgramId(input)).to.throw();
    }
  });

  it("performs safe dry-run by default without executing", () => {
    const res = runFreeze({
      program: VALID_PUBKEY,
      cluster: "devnet",
      execute: false,
    });
    expect(res.success).to.be.true;
    expect(res.dryRun).to.be.true;
    expect(res.solanaArgs).to.include(VALID_PUBKEY);
    expect(res.solanaArgs).to.include("--final");
    expect(res.solanaArgs).to.include("devnet");
  });

  it("refuses to execute without explicit '--confirm FREEZE'", () => {
    expect(() =>
      runFreeze({
        program: VALID_PUBKEY,
        cluster: "devnet",
        execute: true,
        confirm: "NO",
      })
    ).to.throw(/Pass '--confirm FREEZE'/);
  });
});
