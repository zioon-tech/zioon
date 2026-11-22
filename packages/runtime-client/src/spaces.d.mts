export type SpacesClientOptions = {
  baseUrl: string; spaceId?: string; headers?: HeadersInit; fetchImpl?: typeof fetch; signal?: AbortSignal;
};
export function createSpacesClient(options: SpacesClientOptions): {
  request(path: string, options?: { method?: string; body?: unknown; targetSpace?: string }): Promise<any>;
  identity(): Promise<any>; list(): Promise<any>; create(name: string): Promise<any>;
  describe(): Promise<any>; update(body: unknown): Promise<any>;
  contacts(): Promise<any>; addContact(id: string): Promise<any>; removeContact(id: string): Promise<any>;
  accept(token: string): Promise<any>;
  get(tail: string, query?: string): Promise<any>;
  mutate(tail: string, method: string, body?: unknown): Promise<any>;
  document(id: string, tail?: string): Promise<any>;
  mutateDocument(id: string, tail: string, method: string, body?: unknown): Promise<any>;
  transfer(destinationId: string, body: unknown): Promise<any>;
};
