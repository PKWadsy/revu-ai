import type {
  ForgeAdapter,
  ForgeAdapterFactory,
  ForgeContext,
  PostOptions,
  PostResult,
  ResolveContextFlags,
} from "../types.js";

export const gitlabForgeFactory: ForgeAdapterFactory = () => new GitLabForgeAdapter();

export class GitLabForgeAdapter implements ForgeAdapter {
  readonly name = "gitlab";

  async resolveContext(
    _env: NodeJS.ProcessEnv,
    _flags: ResolveContextFlags,
  ): Promise<ForgeContext> {
    throw new Error(
      "GitLab adapter is not yet implemented. The CLI grammar is reserved; the adapter is planned. " +
        "Track progress in the project README under \"Forge integrations\".",
    );
  }

  async post(_options: PostOptions): Promise<PostResult> {
    throw new Error(
      "GitLab adapter is not yet implemented. The CLI grammar is reserved; the adapter is planned. " +
        "Track progress in the project README under \"Forge integrations\".",
    );
  }
}
