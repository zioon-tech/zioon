import { afterEach, describe, expect, it } from "vitest";
import { SqliteAccessStore } from "../src/sqlite-access-store.mjs";

const stores = [];

function createStore(options = {}) {
  const store = new SqliteAccessStore(":memory:", options);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("SqliteAccessStore", () => {
  it("atomically exchanges a one-time pairing for a revocable credential", () => {
    let now = 1_000;
    const store = createStore({ now: () => now });
    const pairing = store.createPairing({
      kind: "resource",
      delivery: "bearer",
      label: "MacBook"
    });

    expect(() => store.exchangePairing({
      pairingId: pairing.pairingId,
      secret: "wrong",
      deviceId: "node:macbook"
    })).toThrow("Pairing invitation is invalid");

    const exchanged = store.exchangePairing({
      pairingId: pairing.pairingId,
      secret: pairing.secret,
      deviceId: "node:macbook",
      platform: "darwin"
    });
    expect(exchanged).toMatchObject({
      delivery: "bearer",
      device: {
        deviceId: "node:macbook",
        kind: "resource",
        scopes: ["node.connect"]
      }
    });
    expect(exchanged.credential).toMatch(/^zion_v1\./);
    expect(store.authenticate(exchanged.credential)).toMatchObject({
      credentialId: exchanged.credentialId,
      device: {
        deviceId: "node:macbook",
        kind: "resource"
      }
    });
    expect(() => store.exchangePairing({
      userCode: pairing.userCode,
      deviceId: "node:other"
    })).toThrow("already been used");

    now += 1_000;
    expect(store.revokeDevice("node:macbook")).toBe(true);
    expect(store.authenticate(exchanged.credential)).toBeNull();
    expect(store.listDevices()).toEqual([
      expect.objectContaining({
        deviceId: "node:macbook",
        revokedAt: now
      })
    ]);
  });

  it("supports manual codes and rejects expired invitations", () => {
    let now = 5_000;
    const store = createStore({ now: () => now });
    const pairing = store.createPairing({
      kind: "client",
      delivery: "cookie",
      ttlMs: 30_000
    });

    now += 30_000;
    expect(() => store.exchangePairing({
      userCode: pairing.userCode.toLowerCase(),
      deviceId: "client:phone"
    })).toThrow("expired");
  });

  it("does not allow a pairing to grant scopes outside its role", () => {
    const store = createStore();

    expect(() => store.createPairing({
      kind: "resource",
      scopes: ["runtime.write"]
    })).toThrow("unsupported resource scopes");
    expect(() => store.createPairing({
      kind: "resource",
      delivery: "cookie"
    })).toThrow("must use bearer");
  });

  it("locks a QR invitation after its failed-attempt budget is consumed", () => {
    const store = createStore({ pairingAttempts: 2 });
    const pairing = store.createPairing({
      kind: "resource",
      delivery: "bearer"
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => store.exchangePairing({
        pairingId: pairing.pairingId,
        secret: "wrong",
        deviceId: "node:test"
      })).toThrow("invalid");
    }
    expect(() => store.exchangePairing({
      pairingId: pairing.pairingId,
      secret: pairing.secret,
      deviceId: "node:test"
    })).toThrow("locked");
  });

  it("does not let a new invitation replace an active device identity", () => {
    const store = createStore();
    const first = store.createPairing({
      kind: "owner",
      delivery: "bearer"
    });
    const owner = store.exchangePairing({
      userCode: first.userCode,
      deviceId: "client:stable"
    });
    const second = store.createPairing({
      kind: "client",
      delivery: "bearer"
    });

    expect(() => store.exchangePairing({
      userCode: second.userCode,
      deviceId: "client:stable"
    })).toThrow("already paired");
    expect(store.authenticate(owner.credential)).toMatchObject({
      device: {
        deviceId: "client:stable",
        kind: "owner"
      }
    });
  });
});
