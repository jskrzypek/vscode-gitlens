import {
	CancellationToken,
	commands,
	ConfigurationChangeEvent,
	Disposable,
	ProgressLocation,
	TreeItem,
	TreeItemCollapsibleState,
	window,
} from 'vscode';
import { configuration, RemotesViewConfig, ViewBranchesLayout, ViewFilesLayout } from '../configuration';
import { Commands } from '../constants';
import { Container } from '../container';
import { GitUri } from '../git/gitUri';
import {
	GitBranch,
	GitBranchReference,
	GitCommit,
	GitReference,
	GitRemote,
	GitRevisionReference,
	RepositoryChange,
	RepositoryChangeComparisonMode,
	RepositoryChangeEvent,
} from '../git/models';
import { executeCommand } from '../system/command';
import { gate } from '../system/decorators/gate';
import {
	BranchNode,
	BranchOrTagFolderNode,
	RemoteNode,
	RemotesNode,
	RepositoriesSubscribeableNode,
	RepositoryFolderNode,
	RepositoryNode,
	ViewNode,
} from './nodes';
import { ViewBase } from './viewBase';

export class RemotesRepositoryNode extends RepositoryFolderNode<RemotesView, RemotesNode> {
	async getChildren(): Promise<ViewNode[]> {
		if (this.child == null) {
			this.child = new RemotesNode(this.uri, this.view, this, this.repo);
		}

		return this.child.getChildren();
	}

	protected changed(e: RepositoryChangeEvent) {
		return e.changed(
			RepositoryChange.Config,
			RepositoryChange.Remotes,
			RepositoryChange.RemoteProviders,
			RepositoryChange.Unknown,
			RepositoryChangeComparisonMode.Any,
		);
	}
}

export class RemotesViewNode extends RepositoriesSubscribeableNode<RemotesView, RemotesRepositoryNode> {
	async getChildren(): Promise<ViewNode[]> {
		if (this.children == null) {
			const repositories = this.view.container.git.openRepositories;
			if (repositories.length === 0) {
				this.view.message = 'No remotes could be found.';

				return [];
			}

			this.view.message = undefined;

			const splat = repositories.length === 1;
			this.children = repositories.map(
				r => new RemotesRepositoryNode(GitUri.fromRepoPath(r.path), this.view, this, r, splat),
			);
		}

		if (this.children.length === 1) {
			const [child] = this.children;

			const remotes = await child.repo.getRemotes();
			if (remotes.length === 0) {
				this.view.message = 'No remotes could be found.';
				this.view.title = 'Remotes';

				void child.ensureSubscription();

				return [];
			}

			this.view.message = undefined;
			this.view.title = `Remotes (${remotes.length})`;

			return child.getChildren();
		}

		return this.children;
	}

	getTreeItem(): TreeItem {
		const item = new TreeItem('Remotes', TreeItemCollapsibleState.Expanded);
		return item;
	}
}

export class RemotesView extends ViewBase<RemotesViewNode, RemotesViewConfig> {
	protected readonly configKey = 'remotes';

	constructor(container: Container) {
		super('gitlens.views.remotes', 'Remotes', container);
	}

	override get canReveal(): boolean {
		return this.config.reveal || !configuration.get('views.repositories.showRemotes');
	}

	protected getRoot() {
		return new RemotesViewNode(this);
	}

	protected registerCommands(): Disposable[] {
		void this.container.viewCommands;

		return [
			commands.registerCommand(
				this.getQualifiedCommand('copy'),
				() => executeCommand(Commands.ViewsCopy, this.selection),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('refresh'),
				() => {
					this.container.git.resetCaches('branches', 'remotes');
					return this.refresh(true);
				},
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setLayoutToList'),
				() => this.setLayout(ViewBranchesLayout.List),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setLayoutToTree'),
				() => this.setLayout(ViewBranchesLayout.Tree),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setFilesLayoutToAuto'),
				() => this.setFilesLayout(ViewFilesLayout.Auto),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setFilesLayoutToList'),
				() => this.setFilesLayout(ViewFilesLayout.List),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setFilesLayoutToTree'),
				() => this.setFilesLayout(ViewFilesLayout.Tree),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setShowAvatarsOn'),
				() => this.setShowAvatars(true),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setShowAvatarsOff'),
				() => this.setShowAvatars(false),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setShowBranchPullRequestOn'),
				() => this.setShowBranchPullRequest(true),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setShowBranchPullRequestOff'),
				() => this.setShowBranchPullRequest(false),
				this,
			),
		];
	}

	protected override filterConfigurationChanged(e: ConfigurationChangeEvent) {
		const changed = super.filterConfigurationChanged(e);
		if (
			!changed &&
			!configuration.changed(e, 'defaultDateFormat') &&
			!configuration.changed(e, 'defaultDateShortFormat') &&
			!configuration.changed(e, 'defaultDateSource') &&
			!configuration.changed(e, 'defaultDateStyle') &&
			!configuration.changed(e, 'defaultGravatarsStyle') &&
			!configuration.changed(e, 'defaultTimeFormat') &&
			!configuration.changed(e, 'integrations.enabled') &&
			!configuration.changed(e, 'sortBranchesBy')
		) {
			return false;
		}

		return true;
	}

	findBranch(branch: GitBranchReference, token?: CancellationToken) {
		if (!branch.remote) return undefined;

		const repoNodeId = RepositoryNode.getId(branch.repoPath);

		return this.findNode((n: any) => n.branch?.ref === branch.ref, {
			allowPaging: true,
			maxDepth: 5,
			canTraverse: n => {
				if (n instanceof RemotesViewNode) return true;

				if (n instanceof RemotesRepositoryNode || n instanceof BranchOrTagFolderNode) {
					return n.id.startsWith(repoNodeId);
				}

				if (n instanceof RemoteNode) {
					if (!n.id.startsWith(repoNodeId)) return false;

					return n.remote.name === GitBranch.getRemote(branch.name);
				}

				return false;
			},
			token: token,
		});
	}

	async findCommit(commit: GitCommit | { repoPath: string; ref: string }, token?: CancellationToken) {
		const repoNodeId = RepositoryNode.getId(commit.repoPath);

		// Get all the remote branches the commit is on
		const branches = await this.container.git.getCommitBranches(
			commit.repoPath,
			commit.ref,
			GitCommit.is(commit) ? { commitDate: commit.committer.date, remotes: true } : { remotes: true },
		);
		if (branches.length === 0) return undefined;

		const remotes = branches.map(b => b.split('/', 1)[0]);

		return this.findNode((n: any) => n.commit !== undefined && n.commit.ref === commit.ref, {
			allowPaging: true,
			maxDepth: 6,
			canTraverse: n => {
				if (n instanceof RemotesViewNode) return true;

				if (n instanceof RemotesRepositoryNode || n instanceof BranchOrTagFolderNode) {
					return n.id.startsWith(repoNodeId);
				}

				if (n instanceof RemoteNode) {
					return n.id.startsWith(repoNodeId) && remotes.includes(n.remote.name);
				}

				if (n instanceof BranchNode) {
					return n.id.startsWith(repoNodeId) && branches.includes(n.branch.name);
				}

				if (n instanceof RepositoryNode || n instanceof RemotesNode || n instanceof BranchOrTagFolderNode) {
					return n.id.startsWith(repoNodeId);
				}

				return false;
			},
			token: token,
		});
	}

	findRemote(remote: GitRemote, token?: CancellationToken) {
		const repoNodeId = RepositoryNode.getId(remote.repoPath);

		return this.findNode((n: any) => n.remote?.name === remote.name, {
			allowPaging: true,
			maxDepth: 2,
			canTraverse: n => {
				if (n instanceof RemotesViewNode) return true;

				if (n instanceof RemotesRepositoryNode) {
					return n.id.startsWith(repoNodeId);
				}

				return false;
			},
			token: token,
		});
	}

	@gate(() => '')
	revealBranch(
		branch: GitBranchReference,
		options?: {
			select?: boolean;
			focus?: boolean;
			expand?: boolean | number;
		},
	) {
		return window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: `Revealing ${GitReference.toString(branch, { icon: false, quoted: true })} in the side bar...`,
				cancellable: true,
			},
			async (progress, token) => {
				const node = await this.findBranch(branch, token);
				if (node == null) return undefined;

				await this.ensureRevealNode(node, options);

				return node;
			},
		);
	}

	@gate(() => '')
	async revealCommit(
		commit: GitRevisionReference,
		options?: {
			select?: boolean;
			focus?: boolean;
			expand?: boolean | number;
		},
	) {
		return window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: `Revealing ${GitReference.toString(commit, { icon: false, quoted: true })} in the side bar...`,
				cancellable: true,
			},
			async (progress, token) => {
				const node = await this.findCommit(commit, token);
				if (node == null) return undefined;

				await this.ensureRevealNode(node, options);

				return node;
			},
		);
	}

	@gate(() => '')
	revealRemote(
		remote: GitRemote,
		options?: {
			select?: boolean;
			focus?: boolean;
			expand?: boolean | number;
		},
	) {
		return window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: `Revealing remote '${remote.name}' in the side bar...`,
				cancellable: true,
			},
			async (progress, token) => {
				const node = await this.findRemote(remote, token);
				if (node == null) return undefined;

				await this.ensureRevealNode(node, options);

				return node;
			},
		);
	}

	@gate(() => '')
	async revealRepository(
		repoPath: string,
		options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
	) {
		const node = await this.findNode(RepositoryFolderNode.getId(repoPath), {
			maxDepth: 1,
			canTraverse: n => n instanceof RemotesViewNode || n instanceof RepositoryFolderNode,
		});

		if (node !== undefined) {
			await this.reveal(node, options);
		}

		return node;
	}

	private setLayout(layout: ViewBranchesLayout) {
		return configuration.updateEffective(`views.${this.configKey}.branches.layout` as const, layout);
	}

	private setFilesLayout(layout: ViewFilesLayout) {
		return configuration.updateEffective(`views.${this.configKey}.files.layout` as const, layout);
	}

	private setShowAvatars(enabled: boolean) {
		return configuration.updateEffective(`views.${this.configKey}.avatars` as const, enabled);
	}

	private async setShowBranchPullRequest(enabled: boolean) {
		await configuration.updateEffective(`views.${this.configKey}.pullRequests.showForBranches` as const, enabled);
		await configuration.updateEffective(`views.${this.configKey}.pullRequests.enabled` as const, enabled);
	}
}
