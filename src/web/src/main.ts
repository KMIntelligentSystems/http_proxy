import {
  AppStorage,
  ChatPanel,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
} from "@mariozechner/pi-web-ui";
import "@mariozechner/pi-web-ui/app.css";
import "./app.css";
import { RemoteAgent } from "./remote-agent";

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const backend = new IndexedDBStorageBackend({
  dbName: "pi-data-visualization-agent",
  version: 1,
  stores: [
    settings.getConfig(),
    SessionsStore.getMetadataConfig(),
    providerKeys.getConfig(),
    customProviders.getConfig(),
    sessions.getConfig(),
  ],
});
settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);
customProviders.setBackend(backend);
setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

function showStatus(kind: "loading" | "error", message: string) {
  app.innerHTML = `
    <main class="boot-screen ${kind}">
      <section>
        <div class="orb"></div>
        <p class="kicker">Data Visualization Agent</p>
        <h1>${kind === "loading" ? "Connecting to backend runtime" : "Could not load the web UI"}</h1>
        <p>${message}</p>
        ${kind === "error" ? `<a href="/ui/portal">Open legacy portal</a>` : ""}
      </section>
    </main>
  `;
}

async function boot() {
  showStatus("loading", "Loading the server-owned Pi AgentSessionRuntime and opening /ui/ws/agent …");

  const agent = new RemoteAgent();
  await agent.connect();

  const panel = new ChatPanel();
  await panel.setAgent(agent as any, {
    onApiKeyRequired: async () => true,
    onModelSelect: () => window.alert("Model selection is controlled by the server-side runtime for this web preview."),
    toolsFactory: () => agent.remoteTools,
  });

  if (panel.agentInterface) {
    panel.agentInterface.enableAttachments = false;
    panel.agentInterface.enableModelSelector = false;
    panel.agentInterface.enableThinkingSelector = false;
  }

  app.replaceChildren(panel);
}

boot().catch((err) => {
  console.error(err);
  showStatus("error", err instanceof Error ? err.message : String(err));
});
