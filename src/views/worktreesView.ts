import {
	CancellationToken,
	commands,
	ConfigurationChangeEvent,
	Disposable,
	ProgressLocation,
	ThemeColor,
	TreeItem,
	TreeItemCollapsibleState,
	TreeViewVisibilityChangeEvent,
	window,
} from 'vscode';
import { configuration, ViewFilesLayout, ViewShowBranchComparison, WorktreesViewConfig } from '../configuration';
import { Container } from '../container';
import { PremiumFeatures } from '../features';
import { GitUri } from '../git/gitUri';
import { GitWorktree, RepositoryChange, RepositoryChangeComparisonMode, RepositoryChangeEvent } from '../git/models';
import { ensurePremiumFeaturesEnabled } from '../premium/subscription/utils';
import { getSubscriptionTimeRemaining, SubscriptionState } from '../subscription';
import { gate } from '../system/decorators/gate';
import { pluralize } from '../system/string';
import {
	RepositoriesSubscribeableNode,
	RepositoryFolderNode,
	RepositoryNode,
	ViewNode,
	WorktreeNode,
	WorktreesNode,
} from './nodes';
import { ViewBase } from './viewBase';

export class WorktreesRepositoryNode extends RepositoryFolderNode<WorktreesView, WorktreesNode> {
	getChildren(): Promise<ViewNode[]> {
		if (this.child == null) {
			this.child = new WorktreesNode(this.uri, this.view, this, this.repo);
		}

		return this.child.getChildren();
	}

	protected changed(e: RepositoryChangeEvent) {
		return e.changed(
			RepositoryChange.Config,
			RepositoryChange.Worktrees,
			RepositoryChange.Unknown,
			RepositoryChangeComparisonMode.Any,
		);
	}
}

export class WorktreesViewNode extends RepositoriesSubscribeableNode<WorktreesView, WorktreesRepositoryNode> {
	async getChildren(): Promise<ViewNode[]> {
		const access = await this.view.container.git.access(PremiumFeatures.Worktrees);
		if (!access.allowed) return [];

		if (this.children == null) {
			const repositories = this.view.container.git.openRepositories;
			if (repositories.length === 0) {
				this.view.message = 'No worktrees could be found.';

				return [];
			}

			this.view.message = undefined;

			const splat = repositories.length === 1;
			this.children = repositories.map(
				r => new WorktreesRepositoryNode(GitUri.fromRepoPath(r.path), this.view, this, r, splat),
			);
		}

		if (this.children.length === 1) {
			const [child] = this.children;

			const children = await child.getChildren();
			if (children.length <= 1) {
				this.view.message = undefined;
				this.view.title = 'Worktrees';

				void child.ensureSubscription();

				return [];
			}

			this.view.message = undefined;
			this.view.title = `Worktrees (${children.length})`;

			return children;
		}

		return this.children;
	}

	getTreeItem(): TreeItem {
		const item = new TreeItem('Worktrees', TreeItemCollapsibleState.Expanded);
		return item;
	}
}

export class WorktreesView extends ViewBase<WorktreesViewNode, WorktreesViewConfig> {
	protected readonly configKey = 'worktrees';

	constructor(container: Container) {
		super('gitlens.views.worktrees', 'Worktrees', container);

		this.disposables.push(
			window.registerFileDecorationProvider({
				provideFileDecoration: (uri, _token) => {
					if (
						uri.scheme !== 'gitlens-view' ||
						uri.authority !== 'worktree' ||
						!uri.path.includes('/changes')
					) {
						return undefined;
					}

					return {
						badge: '●',
						color: new ThemeColor('gitlens.decorations.worktreeView.hasUncommittedChangesForegroundColoSr'),
						tooltip: 'Has Uncommitted Changes',
					};
				},
			}),
		);
	}

	override get canReveal(): boolean {
		return this.config.reveal || !configuration.get('views.repositories.showWorktrees');
	}

	override async show(options?: { preserveFocus?: boolean | undefined }): Promise<void> {
		if (!(await ensurePremiumFeaturesEnabled())) return;
		return super.show(options);
	}

	private _visibleDisposable: Disposable | undefined;
	protected override onVisibilityChanged(e: TreeViewVisibilityChangeEvent): void {
		if (e.visible) {
			void this.updateDescription();
			this._visibleDisposable?.dispose();
			this._visibleDisposable = this.container.subscription.onDidChange(() => void this.updateDescription());
		} else {
			this._visibleDisposable?.dispose();
			this._visibleDisposable = undefined;
		}

		super.onVisibilityChanged(e);
	}

	private async updateDescription() {
		const subscription = await this.container.subscription.getSubscription();

		switch (subscription.state) {
			case SubscriptionState.Free:
			case SubscriptionState.FreePreviewExpired:
			case SubscriptionState.VerificationRequired:
				this.description = '✨ premium feature';
				break;
			case SubscriptionState.FreeInPreview: {
				const days = getSubscriptionTimeRemaining(subscription, 'days')!;
				this.description = `✨⏳ ${pluralize('more day', days)} to try worktrees on public and private repos`;
				break;
			}
			case SubscriptionState.FreePlusInTrial: {
				const days = getSubscriptionTimeRemaining(subscription, 'days')!;
				this.description = `✨⏳ ${pluralize('more day', days)} to try worktrees on private repos`;
				break;
			}
			case SubscriptionState.FreePlusTrialExpired:
			case SubscriptionState.Paid:
				this.description = undefined;
		}
	}

	protected getRoot() {
		return new WorktreesViewNode(this);
	}

	protected registerCommands(): Disposable[] {
		void this.container.viewCommands;

		return [
			commands.registerCommand(
				this.getQualifiedCommand('copy'),
				() => commands.executeCommand('gitlens.views.copy', this.selection),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('refresh'),
				async () => {
					// this.container.git.resetCaches('worktrees');
					return this.refresh(true);
				},
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
				this.getQualifiedCommand('setShowBranchComparisonOn'),
				() => this.setShowBranchComparison(true),
				this,
			),
			commands.registerCommand(
				this.getQualifiedCommand('setShowBranchComparisonOff'),
				() => this.setShowBranchComparison(false),
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
			!configuration.changed(e, 'defaultTimeFormat')
			// !configuration.changed(e, 'sortWorktreesBy')
		) {
			return false;
		}

		return true;
	}

	findWorktree(worktree: GitWorktree, token?: CancellationToken) {
		const repoNodeId = RepositoryNode.getId(worktree.repoPath);

		return this.findNode(WorktreeNode.getId(worktree.repoPath, worktree.uri), {
			maxDepth: 2,
			canTraverse: n => {
				if (n instanceof WorktreesViewNode) return true;

				if (n instanceof WorktreesRepositoryNode) {
					return n.id.startsWith(repoNodeId);
				}

				return false;
			},
			token: token,
		});
	}

	@gate(() => '')
	async revealRepository(
		repoPath: string,
		options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
	) {
		const node = await this.findNode(RepositoryFolderNode.getId(repoPath), {
			maxDepth: 1,
			canTraverse: n => n instanceof WorktreesViewNode || n instanceof RepositoryFolderNode,
		});

		if (node !== undefined) {
			await this.reveal(node, options);
		}

		return node;
	}

	@gate(() => '')
	revealWorktree(
		worktree: GitWorktree,
		options?: {
			select?: boolean;
			focus?: boolean;
			expand?: boolean | number;
		},
	) {
		return window.withProgress(
			{
				location: ProgressLocation.Notification,
				title: `Revealing worktree '${worktree.name}' in the side bar...`,
				cancellable: true,
			},
			async (progress, token) => {
				const node = await this.findWorktree(worktree, token);
				if (node == null) return undefined;

				await this.ensureRevealNode(node, options);

				return node;
			},
		);
	}

	private setFilesLayout(layout: ViewFilesLayout) {
		return configuration.updateEffective(`views.${this.configKey}.files.layout` as const, layout);
	}

	private setShowAvatars(enabled: boolean) {
		return configuration.updateEffective(`views.${this.configKey}.avatars` as const, enabled);
	}

	private setShowBranchComparison(enabled: boolean) {
		return configuration.updateEffective(
			`views.${this.configKey}.showBranchComparison` as const,
			enabled ? ViewShowBranchComparison.Branch : false,
		);
	}

	private async setShowBranchPullRequest(enabled: boolean) {
		await configuration.updateEffective(`views.${this.configKey}.pullRequests.showForBranches` as const, enabled);
		await configuration.updateEffective(`views.${this.configKey}.pullRequests.enabled` as const, enabled);
	}
}
