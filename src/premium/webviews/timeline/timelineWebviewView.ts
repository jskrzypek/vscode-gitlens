'use strict';
import { commands, Disposable, TextEditor, Uri, window } from 'vscode';
import type { ShowQuickCommitCommandArgs } from '../../../commands';
import { configuration } from '../../../configuration';
import { Commands } from '../../../constants';
import { Container } from '../../../container';
import { PremiumFeatures } from '../../../features';
import type { RepositoriesChangeEvent } from '../../../git/gitProviderService';
import { GitUri } from '../../../git/gitUri';
import { RepositoryChange, RepositoryChangeComparisonMode, RepositoryChangeEvent } from '../../../git/models';
import { createFromDateDelta } from '../../../system/date';
import { debug } from '../../../system/decorators/log';
import { debounce, Deferrable } from '../../../system/function';
import { filter } from '../../../system/iterable';
import { hasVisibleTextEditor, isTextEditor } from '../../../system/utils';
import { IpcMessage, onIpc } from '../../../webviews/protocol';
import { WebviewViewBase } from '../../../webviews/webviewViewBase';
import type { SubscriptionChangeEvent } from '../../subscription/subscriptionService';
import { ensurePremiumFeaturesEnabled } from '../../subscription/utils';
import {
	Commit,
	DidChangeStateNotificationType,
	OpenDataPointCommandType,
	Period,
	State,
	UpdatePeriodCommandType,
} from './protocol';

interface Context {
	uri: Uri | undefined;
	period: Period | undefined;
	etagRepositories: number | undefined;
	etagRepository: number | undefined;
	etagSubscription: number | undefined;
}

const defaultPeriod: Period = '3|M';

export class TimelineWebviewView extends WebviewViewBase<State> {
	private _bootstraping = true;
	/** The context the webview has */
	private _context: Context;
	/** The context the webview should have */
	private _pendingContext: Partial<Context> | undefined;

	constructor(container: Container) {
		super(container, 'gitlens.views.timeline', 'timeline.html', 'Visual File History');

		this._context = {
			uri: undefined,
			period: defaultPeriod,
			etagRepositories: 0,
			etagRepository: 0,
			etagSubscription: 0,
		};
	}

	override async show(options?: { preserveFocus?: boolean | undefined }): Promise<void> {
		if (!(await ensurePremiumFeaturesEnabled())) return;
		return super.show(options);
	}

	protected override onInitializing(): Disposable[] | undefined {
		this._context = {
			uri: undefined,
			period: defaultPeriod,
			etagRepositories: this.container.git.etag,
			etagRepository: 0,
			etagSubscription: this.container.subscription.etag,
		};

		this.updatePendingEditor(window.activeTextEditor);
		this._context = { ...this._context, ...this._pendingContext };
		this._pendingContext = undefined;

		return [
			this.container.subscription.onDidChange(this.onSubscriptionChanged, this),
			window.onDidChangeActiveTextEditor(this.onActiveEditorChanged, this),
			this.container.git.onDidChangeRepository(this.onRepositoryChanged, this),
			this.container.git.onDidChangeRepositories(this.onRepositoriesChanged, this),
		];
	}

	protected override async includeBootstrap(): Promise<State> {
		this._bootstraping = true;

		this._context = { ...this._context, ...this._pendingContext };
		this._pendingContext = undefined;

		return this.getState(this._context);
	}

	protected override registerCommands(): Disposable[] {
		return [
			commands.registerCommand(`${this.id}.refresh`, () => this.refresh(), this),
			commands.registerCommand(`${this.id}.openInTab`, () => this.openInTab(), this),
		];
	}

	protected override onVisibilityChanged(visible: boolean) {
		if (!visible) return;

		// Since this gets called even the first time the webview is shown, avoid sending an update, because the bootstrap has the data
		if (this._bootstraping) {
			this._bootstraping = false;

			// If the uri changed since bootstrap still send the update
			if (this._pendingContext == null || !('uri' in this._pendingContext)) {
				return;
			}
		}

		// Should be immediate, but it causes the bubbles to go missing on the chart, since the update happens while it still rendering
		this.updateState();
	}

	protected override onMessageReceived(e: IpcMessage) {
		switch (e.method) {
			case OpenDataPointCommandType.method:
				onIpc(OpenDataPointCommandType, e, params => {
					if (params.data == null || !params.data.selected || this._context.uri == null) return;

					const repository = this.container.git.getRepository(this._context.uri);
					if (repository == null) return;

					const commandArgs: ShowQuickCommitCommandArgs = {
						repoPath: repository.path,
						sha: params.data.id,
					};

					void commands.executeCommand(Commands.ShowQuickCommit, commandArgs);

					// const commandArgs: DiffWithPreviousCommandArgs = {
					// 	line: 0,
					// 	showOptions: {
					// 		preserveFocus: true,
					// 		preview: true,
					// 		viewColumn: ViewColumn.Beside,
					// 	},
					// };

					// void commands.executeCommand(
					// 	Commands.DiffWithPrevious,
					// 	new GitUri(gitUri, { repoPath: gitUri.repoPath!, sha: params.data.id }),
					// 	commandArgs,
					// );
				});

				break;

			case UpdatePeriodCommandType.method:
				onIpc(UpdatePeriodCommandType, e, params => {
					if (this.updatePendingContext({ period: params.period })) {
						this.updateState(true);
					}
				});

				break;
		}
	}

	@debug({ args: false })
	private onActiveEditorChanged(editor: TextEditor | undefined) {
		if (!this.updatePendingEditor(editor)) return;

		this.updateState();
	}

	@debug({ args: false })
	private onRepositoriesChanged(e: RepositoriesChangeEvent) {
		const changed = this.updatePendingUri(this._context.uri);

		if (this.updatePendingContext({ etagRepositories: e.etag }) || changed) {
			this.updateState();
		}
	}

	@debug({ args: false })
	private onRepositoryChanged(e: RepositoryChangeEvent) {
		if (!e.changed(RepositoryChange.Heads, RepositoryChange.Index, RepositoryChangeComparisonMode.Any)) {
			return;
		}

		if (this.updatePendingContext({ etagRepository: e.repository.etag })) {
			this.updateState();
		}
	}

	@debug({ args: false })
	private onSubscriptionChanged(e: SubscriptionChangeEvent) {
		if (this.updatePendingContext({ etagSubscription: e.etag })) {
			this.updateState();
		}
	}

	@debug({ args: false })
	private async getState(current: Context): Promise<State> {
		const access = await this.container.git.access(PremiumFeatures.Timeline);
		const dateFormat = this.container.config.defaultDateFormat ?? 'MMMM Do, YYYY h:mma';
		const period = current.period ?? defaultPeriod;

		if (!access.allowed) {
			const dataset = generateRandomTimelineDataset();
			return {
				dataset: dataset.sort((a, b) => b.sort - a.sort),
				period: period,
				title: 'src/app/index.ts',
				uri: Uri.file('src/app/index.ts').toString(),
				dateFormat: dateFormat,
				access: access,
			};
		}

		if (current.uri == null) {
			return {
				period: period,
				title: 'There are no editors open that can provide file history information',
				dateFormat: dateFormat,
				access: access,
			};
		}

		const gitUri = await GitUri.fromUri(current.uri);
		const repoPath = gitUri.repoPath!;
		const title = gitUri.relativePath;

		this.description = gitUri.fileName;

		const [currentUser, log] = await Promise.all([
			this.container.git.getCurrentUser(repoPath),
			this.container.git.getLogForFile(repoPath, gitUri.fsPath, {
				limit: 0,
				ref: gitUri.sha,
				since: this.getPeriodDate(period).toISOString(),
			}),
		]);

		if (log == null) {
			return {
				dataset: [],
				period: period,
				title: 'No commits found for the specified time period',
				uri: current.uri.toString(),
				dateFormat: dateFormat,
				access: access,
			};
		}

		let queryRequiredCommits = [
			...filter(log.commits.values(), c => c.file?.stats == null && c.stats?.changedFiles !== 1),
		];

		if (queryRequiredCommits.length !== 0) {
			const limit = configuration.get('visualHistory.queryLimit') ?? 20;

			const repository = this.container.git.getRepository(current.uri);
			const name = repository?.provider.name;

			if (queryRequiredCommits.length > limit) {
				void window.showWarningMessage(
					`Unable able to show more than the first ${limit} commits for the specified time period because of ${
						name ? `${name} ` : ''
					}rate limits.`,
				);
				queryRequiredCommits = queryRequiredCommits.slice(0, 20);
			}

			void (await Promise.allSettled(queryRequiredCommits.map(c => c.ensureFullDetails())));
		}

		const name = currentUser?.name ? `${currentUser.name} (you)` : 'You';

		const dataset: Commit[] = [];
		for (const commit of log.commits.values()) {
			const stats = commit.file?.stats ?? (commit.stats?.changedFiles === 1 ? commit.stats : undefined);
			dataset.push({
				author: commit.author.name === 'You' ? name : commit.author.name,
				additions: stats?.additions,
				deletions: stats?.deletions,
				commit: commit.sha,
				date: commit.date.toISOString(),
				message: commit.message ?? commit.summary,
				sort: commit.date.getTime(),
			});
		}

		dataset.sort((a, b) => b.sort - a.sort);

		return {
			dataset: dataset,
			period: period,
			title: title,
			uri: current.uri.toString(),
			dateFormat: dateFormat,
			access: access,
		};
	}

	private getPeriodDate(period: Period): Date {
		const [number, unit] = period.split('|');

		switch (unit) {
			case 'D':
				return createFromDateDelta(new Date(), { days: -parseInt(number, 10) });
			case 'M':
				return createFromDateDelta(new Date(), { months: -parseInt(number, 10) });
			case 'Y':
				return createFromDateDelta(new Date(), { years: -parseInt(number, 10) });
			default:
				return createFromDateDelta(new Date(), { months: -3 });
		}
	}

	private openInTab() {
		const uri = this._context.uri;
		if (uri == null) return;

		void commands.executeCommand(Commands.ShowTimelinePage, uri);
	}

	private updatePendingContext(context: Partial<Context>): boolean {
		let changed = false;
		for (const [key, value] of Object.entries(context)) {
			const current = (this._context as unknown as Record<string, unknown>)[key];
			if (
				current === value ||
				((current instanceof Uri || value instanceof Uri) && (current as any)?.toString() === value?.toString())
			) {
				continue;
			}

			if (this._pendingContext == null) {
				this._pendingContext = {};
			}

			(this._pendingContext as Record<string, unknown>)[key] = value;
			changed = true;
		}

		return changed;
	}

	private updatePendingEditor(editor: TextEditor | undefined): boolean {
		if (editor == null && hasVisibleTextEditor()) return false;
		if (editor != null && !isTextEditor(editor)) return false;

		return this.updatePendingUri(editor?.document.uri);
	}

	private updatePendingUri(uri: Uri | undefined): boolean {
		let etag;
		if (uri != null) {
			const repository = this.container.git.getRepository(uri);
			etag = repository?.etag ?? 0;
		} else {
			etag = 0;
		}

		return this.updatePendingContext({ uri: uri, etagRepository: etag });
	}

	private _notifyDidChangeStateDebounced: Deferrable<() => void> | undefined = undefined;

	@debug()
	private updateState(immediate: boolean = false) {
		if (!this.isReady || !this.visible) return;

		this.updatePendingEditor(window.activeTextEditor);

		if (immediate) {
			void this.notifyDidChangeState();
			return;
		}

		if (this._notifyDidChangeStateDebounced == null) {
			this._notifyDidChangeStateDebounced = debounce(this.notifyDidChangeState.bind(this), 500);
		}

		this._notifyDidChangeStateDebounced();
	}

	@debug()
	private async notifyDidChangeState() {
		if (!this.isReady || !this.visible) return false;

		this._notifyDidChangeStateDebounced?.cancel();
		if (this._pendingContext == null) return false;

		const context = { ...this._context, ...this._pendingContext };

		return window.withProgress({ location: { viewId: this.id } }, async () => {
			const success = await this.notify(DidChangeStateNotificationType, {
				state: await this.getState(context),
			});
			if (success) {
				this._context = context;
				this._pendingContext = undefined;
			}
		});
	}
}

export function generateRandomTimelineDataset(): Commit[] {
	const dataset: Commit[] = [];
	const authors = ['Eric Amodio', 'Justin Roberts', 'Ada Lovelace', 'Grace Hopper'];

	const count = 10;
	for (let i = 0; i < count; i++) {
		// Generate a random date between now and 3 months ago
		const date = new Date(new Date().getTime() - Math.floor(Math.random() * (3 * 30 * 24 * 60 * 60 * 1000)));

		dataset.push({
			commit: String(i),
			author: authors[Math.floor(Math.random() * authors.length)],
			date: date.toISOString(),
			message: '',
			// Generate random additions/deletions between 1 and 20, but ensure we have a tiny and large commit
			additions: i === 0 ? 2 : i === count - 1 ? 50 : Math.floor(Math.random() * 20) + 1,
			deletions: i === 0 ? 1 : i === count - 1 ? 25 : Math.floor(Math.random() * 20) + 1,
			sort: date.getTime(),
		});
	}

	return dataset;
}
