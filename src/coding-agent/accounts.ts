import { userInfo } from "node:os";
import { join } from "node:path";
import type { Api, AuthInteraction, AuthPrompt, Model, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

export type AccountUI = AuthInteraction & { signal: AbortSignal; say(message: string): void };
export type Connection =
  | { type: "catalog"; runtime: ModelRuntime; model: Model<Api> }
  | { type: "environment"; model: string; apiKey: string; baseURL?: string };

export const accountCommands = ["login", "logout", "model", "providers", "status"] as const;

export function createAccounts(accountDirectory?: string) {
  const defaultDirectory = join(userInfo().homedir, ".theta");
  const directory = accountDirectory ?? defaultDirectory;
  const { OPENAI_API_KEY, OPENAI_API_BASE, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
  const environmentModel = OPENAI_MODEL?.trim();
  const environmentKey = OPENAI_API_KEY?.trim();
  const baseURL = OPENAI_BASE_URL?.trim() || OPENAI_API_BASE?.trim();
  // pi uses OPENAI_API_KEY for its OpenAI catalog even when the legacy key belongs to a gateway.
  if (baseURL && baseURL.replace(/\/+$/, "") !== "https://api.openai.com/v1") {
    delete process.env.OPENAI_API_KEY;
  }
  const settings = SettingsManager.create(directory, directory, { projectTrusted: false });
  const authPath = join(directory, "auth.json");
  const modelsPath = join(directory, "models.json");
  const credentialPaths = [...new Set([
    authPath, modelsPath, join(defaultDirectory, "auth.json"), join(defaultDirectory, "models.json"),
  ])];
  let runtimePromise: Promise<ModelRuntime> | undefined;

  function runtime(): Promise<ModelRuntime> {
    return runtimePromise ??= ModelRuntime.create({
      authPath,
      modelsPath,
    });
  }

  async function settleAccountWrites(): Promise<void> {
    await (await runtimePromise)?.settleCredentialWrites();
    await settings.flush();
  }

  function selectedModel() {
    const { defaultProvider, defaultModel } = settings.getGlobalSettings();
    if (defaultProvider && defaultProvider !== "env" && defaultModel) {
      return { provider: defaultProvider, id: defaultModel };
    }
  }

  function modelLabel(): string {
    const selected = selectedModel();
    if (selected) return `${selected.provider}/${selected.id}`;
    return environmentModel && environmentKey ? `${environmentModel} · 环境配置` : "尚未选择模型";
  }

  async function connection(): Promise<Connection> {
    const selected = selectedModel();
    if (selected) {
      const models = await runtime();
      const model = models.getModel(selected.provider, selected.id);
      if (!model) throw new Error(`服务商目录中找不到模型 ${modelLabel()}。请运行 theta model 重新选择。`);
      if (!await models.checkAuth(selected.provider)) throw new Error(`请先运行 theta login ${selected.provider} 或配置该服务商的环境凭据。`);
      return { type: "catalog", runtime: models, model };
    }
    if (!environmentModel || !environmentKey) {
      throw new Error("请先使用 /login 登录、用 /model 选择已配置的模型，或设置 OPENAI_API_KEY 和 OPENAI_MODEL。");
    }
    return { type: "environment", model: environmentModel, apiKey: environmentKey, baseURL };
  }

  type Choice = Extract<AuthPrompt, { type: "select" }>["options"][number];

  async function choose(ui: AccountUI | undefined, message: string, options: Choice[]): Promise<string> {
    if (!ui) throw new Error(`${message}需要交互终端。请在终端中运行 theta。`);
    if (!options.length) throw new Error(`${message}：没有可选项。`);
    if (options.length === 1) return options[0].id;
    return ui.prompt({ type: "select", message, options });
  }

  function authMethods(provider: Provider): Choice[] {
    const { apiKey, oauth } = provider.auth;
    const methods: Choice[] = [];
    if (oauth) methods.push({ id: "oauth", label: oauth.loginLabel ?? oauth.name });
    if (apiKey?.login) methods.push({ id: "api_key", label: apiKey.name });
    return methods;
  }

  async function selectModel(models: ModelRuntime, provider: string, id: string | undefined, ui?: AccountUI): Promise<string> {
    if (provider !== "env") {
      if (!models.getProvider(provider)) throw new Error(`未知服务商 ${provider}。用 theta providers 查看列表。`);
      if (!await models.checkAuth(provider)) throw new Error(`请先登录 ${provider} 或配置该服务商的环境凭据。`);
      let catalog = models.getModels(provider);
      if (!catalog.length || (id && !models.getModel(provider, id))) {
        const result = await models.refresh({ providers: [provider], allowNetwork: process.env.PI_OFFLINE === undefined, signal: ui?.signal });
        ui?.signal.throwIfAborted();
        const error = result.errors.get(provider);
        if (error) throw error;
        catalog = models.getModels(provider);
      }
      if (!catalog.length) throw new Error(`${provider} 没有可用的对话模型。`);
      id ??= await choose(ui, `选择 ${provider} 的模型`, catalog.map(m => ({ id: m.id, label: m.id, description: m.name })));
      if (!models.getModel(provider, id)) throw new Error(`${provider} 没有模型 ${id}。`);
    }
    settings.setDefaultModelAndProvider(provider, id ?? "env");
    await settings.flush();
    const failure = settings.drainErrors()[0];
    if (failure) throw failure.error;
    return `当前模型  ${modelLabel()}`;
  }

  async function accountCommand(name: string, args: string[], ui?: AccountUI): Promise<string> {
    const models = await runtime();
    const providers = [...models.getProviders()].sort((a, b) => a.name.localeCompare(b.name));
    const [target, method] = args;
    if (args.length > (name === "login" ? 2 : name === "status" || name === "providers" ? 0 : 1)) {
      throw new Error(`theta ${name} 参数过多。请查看 theta --help。`);
    }
    switch (name) {
      case "providers":
        return providers.map(p => `${p.id}  ${authMethods(p).map(m => m.id).join(" / ") || "环境凭据"}`).join("\n");
      case "status": {
        const credentials = await models.listCredentials();
        const available = [...new Set(models.getAvailableSnapshot().map(m => m.provider))];
        return [`当前模型  ${modelLabel()}`, `已保存凭据  ${credentials.map(c => `${c.providerId} (${c.type})`).join("、") || "无"}`,
          `已配置的对话服务商  ${available.join("、") || "无"}`].join("\n");
      }
      case "logout": {
        const stored = await models.listCredentials();
        if (!stored.length && !target) return "没有已保存的登录凭据。";
        const id = target ?? await choose(ui, "选择要退出的服务商", stored.map(c => ({ id: c.providerId, label: c.providerId })));
        if (!stored.some(c => c.providerId === id)) throw new Error(`${id} 没有保存在 Theta 的凭据。`);
        await models.logout(id, { signal: ui?.signal });
        const ambient = await models.checkAuth(id);
        return `已移除 ${id} 的本地凭据。${ambient ? "环境或服务商配置仍然有效。" : ""}`;
      }
      case "login": {
        if (!ui) throw new Error("登录需要交互终端。请在终端中运行 theta login。");
        const methodFilter = target ? method : await choose(ui, "选择登录方式", [
          { id: "oauth", label: "使用账号登录", description: "浏览器授权或设备码" },
          { id: "api_key", label: "配置 API Key 或云凭据" },
        ]);
        const id = target ?? await choose(ui, "选择登录服务商", providers.filter(p => authMethods(p).some(m => m.id === methodFilter))
          .map(p => ({ id: p.id, label: p.name, description: p.id })));
        const provider = models.getProvider(id);
        if (!provider) throw new Error(`未知服务商 ${id}。用 theta providers 查看列表。`);
        const methods = authMethods(provider);
        if (!methods.length) throw new Error(`${provider.name} 使用环境凭据。配置后请运行 theta model。`);
        const type = methodFilter ?? await choose(ui, `登录 ${provider.name}`, methods);
        if ((type !== "oauth" && type !== "api_key") || !methods.some(m => m.id === type)) {
          throw new Error(`${id} 支持的登录方式：${methods.map(m => m.id).join("、")}`);
        }
        await models.login(id, type, ui, { agentName: "Theta", getDeviceId: () => settings.getOrCreateDeviceId() });
        await settings.flush();
        const saved = `已保存 ${provider.name} 凭据。`;
        ui.say(saved);
        try {
          return await selectModel(models, id, undefined, ui);
        } catch (cause) {
          if (ui.signal.aborted) return saved + "已取消模型选择，可稍后运行 theta model。";
          throw new Error(saved + (cause instanceof Error ? cause.message : String(cause)), { cause });
        }
      }
      case "model": {
        if (target === "env") return selectModel(models, "env", undefined);
        const [providerId, ...modelId] = target?.split("/") ?? [];
        const available = providers.filter(p => models.getProviderAuthStatus(p.id).configured);
        if (!providerId && !available.length) throw new Error("请先用 /login 登录服务商，或配置其环境凭据。");
        const provider = providerId || await choose(ui, "选择已配置的服务商",
          available.map(p => ({ id: p.id, label: p.name, description: p.id })));
        return selectModel(models, provider, modelId.length ? modelId.join("/") : undefined, ui);
      }
      default: throw new Error(`未知账号命令 ${name}`);
    }
  }

  return { credentialPaths, connection, modelLabel, accountCommand, settleAccountWrites };
}

export type Accounts = ReturnType<typeof createAccounts>;
