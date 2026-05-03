export type StudioIntegrationConfig = {
  enabled: boolean;
  apiUrl: string;
  token?: string;
};

export type StudioMarker = {
  id: string;
  label: string | null;
  created_at: string;
};

type StudioApiResponse<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

export const loadStudioIntegrationConfig = (): StudioIntegrationConfig => ({
  enabled: parseBoolean(process.env.VAEXCORE_STUDIO_INTEGRATION),
  apiUrl: normalizeApiUrl(
    process.env.VAEXCORE_STUDIO_API_URL || "http://127.0.0.1:51287"
  ),
  token: optionalString(process.env.VAEXCORE_STUDIO_API_TOKEN)
});

export class StudioClient {
  constructor(private readonly config: StudioIntegrationConfig) {}

  async health() {
    return this.request<{
      service: string;
      version: string;
      ok: boolean;
      auth_required: boolean;
      dev_auth_bypass: boolean;
    }>("/health");
  }

  async createMarker(label: string) {
    return this.request<StudioMarker>("/marker/create", {
      method: "POST",
      body: JSON.stringify({ label })
    });
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-vaexcore-client-id", "vaexcore-console");
    headers.set("x-vaexcore-client-name", "vaexcore console");
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (this.config.token) {
      headers.set("x-vaexcore-token", this.config.token);
    }

    const response = await fetch(`${this.config.apiUrl}${path}`, {
      ...init,
      headers
    });
    const payload = (await response.json().catch(() => null)) as
      | StudioApiResponse<T>
      | null;

    if (!response.ok || !payload?.ok || payload.data === null) {
      throw new Error(
        payload?.error?.message ||
          `Studio request failed with HTTP ${response.status}`
      );
    }

    return payload.data;
  }
}

const parseBoolean = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const optionalString = (value: string | undefined) => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const normalizeApiUrl = (apiUrl: string) => apiUrl.replace(/\/+$/, "");
