import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  loadConfigFromEnv,
  parseCluster,
  parseRpcUrl,
  parseInteger,
  parsePublicKey,
  parseFeedId,
  parseIdentityKeypair,
} from "../agent/src/config";

describe("TASK 04 — Agent Environment Configuration Validation", () => {
  const dummyKp = Keypair.generate();
  const dummyB58 = bs58.encode(dummyKp.secretKey);

  describe("parseCluster", () => {
    it("accepts valid clusters", () => {
      expect(parseCluster("localnet")).to.equal("localnet");
      expect(parseCluster("devnet")).to.equal("devnet");
      expect(parseCluster("mainnet-beta")).to.equal("mainnet-beta");
    });

    it("defaults to localnet when omitted", () => {
      expect(parseCluster(undefined)).to.equal("localnet");
      expect(parseCluster("")).to.equal("localnet");
    });

    it("rejects unknown cluster strings", () => {
      expect(() => parseCluster("testnet-fake")).to.throw(/Invalid CLUSTER/);
      expect(() => parseCluster("production")).to.throw(/Invalid CLUSTER/);
    });
  });

  describe("parseRpcUrl", () => {
    it("accepts valid http and https URLs", () => {
      expect(parseRpcUrl("localnet", "http://127.0.0.1:8899")).to.equal("http://127.0.0.1:8899");
      expect(parseRpcUrl("mainnet-beta", "https://api.mainnet-beta.solana.com")).to.equal(
        "https://api.mainnet-beta.solana.com"
      );
    });

    it("rejects non-http/https protocols", () => {
      expect(() => parseRpcUrl("devnet", "ftp://example.com")).to.throw(/protocol/);
      expect(() => parseRpcUrl("devnet", "javascript:alert(1)")).to.throw();
    });

    it("rejects malformed URLs", () => {
      expect(() => parseRpcUrl("devnet", "not-a-valid-url")).to.throw();
    });
  });

  describe("parseInteger", () => {
    it("parses valid integers within bounds", () => {
      expect(parseInteger("TEST", "42", 10)).to.equal(42);
      expect(parseInteger("TEST", undefined, 10)).to.equal(10);
      expect(parseInteger("TEST", "", 10)).to.equal(10);
    });

    it("rejects NaN and floating point numbers", () => {
      expect(() => parseInteger("TEST", "abc", 10)).to.throw(/Invalid integer/);
      expect(() => parseInteger("TEST", "NaN", 10)).to.throw(/Invalid integer/);
      expect(() => parseInteger("TEST", "12.34", 10)).to.throw(/Invalid integer/);
    });

    it("enforces minimum and maximum bounds", () => {
      expect(() => parseInteger("TEST", "-5", 10, { min: 0 })).to.throw(/>=/);
      expect(() => parseInteger("TEST", "1500000", 10, { max: 1400000 })).to.throw(/<=/);
      expect(parseInteger("TEST", "1400000", 10, { max: 1400000 })).to.equal(1400000);
      expect(parseInteger("TEST", "0", 10, { min: 0 })).to.equal(0);
    });
  });

  describe("parsePublicKey", () => {
    it("parses valid base58 public keys", () => {
      const pk = dummyKp.publicKey;
      expect(parsePublicKey("TEST", pk.toBase58())?.toBase58()).to.equal(pk.toBase58());
    });

    it("returns undefined for empty input", () => {
      expect(parsePublicKey("TEST", undefined)).to.be.undefined;
      expect(parsePublicKey("TEST", "")).to.be.undefined;
    });

    it("rejects invalid public keys", () => {
      expect(() => parsePublicKey("TEST", "invalid-pk")).to.throw(/Invalid PublicKey/);
    });
  });

  describe("parseFeedId", () => {
    it("parses valid 64-character hex feed IDs", () => {
      const hex = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
      const buf = parseFeedId("FEED", hex);
      expect(buf).to.not.be.undefined;
      expect(buf?.length).to.equal(32);
      expect(buf?.toString("hex")).to.equal(hex);
    });

    it("rejects non-hex or invalid length strings", () => {
      expect(() => parseFeedId("FEED", "1234")).to.throw(/64-character hex/);
      expect(() =>
        parseFeedId("FEED", "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b5zz")
      ).to.throw(/64-character hex/);
    });
  });

  describe("loadConfigFromEnv integration", () => {
    it("successfully loads config with minimal valid environment", () => {
      const env: NodeJS.ProcessEnv = {
        AGENT_SECRET_KEY_B58: dummyB58,
        CLUSTER: "devnet",
      };
      const cfg = loadConfigFromEnv(env);
      expect(cfg.cluster).to.equal("devnet");
      expect(cfg.identity.publicKey.toBase58()).to.equal(dummyKp.publicKey.toBase58());
      expect(cfg.pollIntervalSecs).to.equal(30);
      expect(cfg.crankTradeComputeUnits).to.equal(400000);
      expect(cfg.crankStakeComputeUnits).to.equal(150000);
      expect(cfg.jupiterSlippageBps).to.equal(50);
    });

    it("fails when missing identity", () => {
      expect(() => loadConfigFromEnv({})).to.throw(/Missing agent identity/);
    });

    it("fails when JUP_API_BASE=off is set on mainnet-beta", () => {
      const env: NodeJS.ProcessEnv = {
        AGENT_SECRET_KEY_B58: dummyB58,
        CLUSTER: "mainnet-beta",
        JUP_API_BASE: "off",
      };
      expect(() => loadConfigFromEnv(env)).to.throw(/JUP_API_BASE=off is strictly prohibited/);
    });

    it("rejects negative poll intervals or excessive CUs", () => {
      expect(() =>
        loadConfigFromEnv({
          AGENT_SECRET_KEY_B58: dummyB58,
          POLL_INTERVAL_SECS: "-1",
        })
      ).to.throw(/POLL_INTERVAL_SECS must be >= 1/);

      expect(() =>
        loadConfigFromEnv({
          AGENT_SECRET_KEY_B58: dummyB58,
          CRANK_TRADE_CU: "2000000",
        })
      ).to.throw(/CRANK_TRADE_CU must be <= 1400000/);
    });
  });
});
