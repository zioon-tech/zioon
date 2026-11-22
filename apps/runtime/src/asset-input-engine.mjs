import {
  ASSET_URI_PREFIX,
  assetIdFromUri
} from "./asset-service.mjs";

async function materializeMessage(message, assets, maxInlineBytes, authorizeAsset, request) {
  if (!Array.isArray(message?.content)) return message;
  const content = await Promise.all(message.content.map(async (part) => {
    if (part?.type !== "image_url") return part;
    const source = String(part.image_url?.url || "");
    if (!source.startsWith(ASSET_URI_PREFIX)) return part;
    const assetId = assetIdFromUri(source);
    if (!assetId) {
      throw Object.assign(new Error("Asset reference is invalid"), {
        code: "ASSET_REFERENCE_INVALID",
        statusCode: 422
      });
    }
    await authorizeAsset?.(request, assetId);
    return {
      ...part,
      image_url: {
        ...part.image_url,
        url: await assets.readDataUrl(assetId, { maxBytes: maxInlineBytes })
      }
    };
  }));
  return { ...message, content };
}

export class AssetInputEngine {
  constructor({
    engine,
    assets,
    maxInlineBytes,
    authorizeAsset = null
  }) {
    if (!engine?.streamTurn) throw new Error("AssetInputEngine requires an Agent engine");
    if (!assets?.readDataUrl) throw new Error("AssetInputEngine requires an AssetService");
    this.engine = engine;
    this.assets = assets;
    this.maxInlineBytes = Number(maxInlineBytes);
    this.authorizeAsset = authorizeAsset;
    this.id = engine.id;
  }

  async materialize(request) {
    const messages = await Promise.all(
      request.messages.map((message) =>
        materializeMessage(message, this.assets, this.maxInlineBytes, this.authorizeAsset, request)
      )
    );
    return {
      ...request,
      messages
    };
  }
  async *streamTurn(request) {
    yield* this.engine.streamTurn(await this.materialize(request));
  }
}
