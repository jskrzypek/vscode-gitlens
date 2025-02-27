import {
	authentication,
	AuthenticationSession,
	AuthenticationSessionsChangeEvent,
	version as codeVersion,
	commands,
	Disposable,
	env,
	Event,
	EventEmitter,
	MarkdownString,
	MessageItem,
	StatusBarAlignment,
	StatusBarItem,
	ThemeColor,
	Uri,
	window,
} from 'vscode';
import { fetch } from '@env/fetch';
import { getPlatform } from '@env/platform';
import { configuration } from '../../configuration';
import { Commands, ContextKeys } from '../../constants';
import type { Container } from '../../container';
import { setContext } from '../../context';
import { AccountValidationError } from '../../errors';
import { RepositoriesChangeEvent } from '../../git/gitProviderService';
import { Logger } from '../../logger';
import { StorageKeys, WorkspaceStorageKeys } from '../../storage';
import {
	computeSubscriptionState,
	getSubscriptionPlan,
	getSubscriptionPlanPriority,
	getSubscriptionTimeRemaining,
	getTimeRemaining,
	isSubscriptionExpired,
	isSubscriptionPaidPlan,
	isSubscriptionTrial,
	Subscription,
	SubscriptionPlanId,
	SubscriptionState,
} from '../../subscription';
import { executeCommand } from '../../system/command';
import { createFromDateDelta } from '../../system/date';
import { gate } from '../../system/decorators/gate';
import { debug, log } from '../../system/decorators/log';
import { memoize } from '../../system/decorators/memoize';
import { once } from '../../system/function';
import { pluralize } from '../../system/string';
import { openWalkthrough } from '../../system/utils';
import { ensurePremiumFeaturesEnabled } from './utils';

// TODO: What user-agent should we use?
const userAgent = 'Visual-Studio-Code-GitLens';

export interface SubscriptionChangeEvent {
	readonly current: Subscription;
	readonly previous: Subscription;
	readonly etag: number;
}

export class SubscriptionService implements Disposable {
	private static authenticationProviderId = 'gitlens-gitkraken';
	private static authenticationScopes = ['gitlens'];

	private _onDidChange = new EventEmitter<SubscriptionChangeEvent>();
	get onDidChange(): Event<SubscriptionChangeEvent> {
		return this._onDidChange.event;
	}

	private _disposable: Disposable;
	private _subscription!: Subscription;
	private _statusBarSubscription: StatusBarItem | undefined;

	constructor(private readonly container: Container) {
		this._disposable = Disposable.from(
			once(container.onReady)(this.onReady, this),
			authentication.onDidChangeSessions(this.onAuthenticationChanged, this),
		);

		this.changeSubscription(this.getStoredSubscription(), true);
		setTimeout(() => void this.ensureSession(false), 10000);
	}

	dispose(): void {
		this._statusBarSubscription?.dispose();

		this._disposable.dispose();
	}

	private onAuthenticationChanged(e: AuthenticationSessionsChangeEvent): void {
		if (e.provider.id !== SubscriptionService.authenticationProviderId) return;

		void this.ensureSession(false, true);
	}

	@memoize()
	private get baseApiUri(): Uri {
		const { env } = this.container;
		if (env === 'staging') {
			return Uri.parse('https://stagingapi.gitkraken.com');
		}

		if (env === 'dev') {
			return Uri.parse('https://devapi.gitkraken.com');
		}

		return Uri.parse('https://api.gitkraken.com');
	}

	@memoize()
	private get baseAccountUri(): Uri {
		const { env } = this.container;
		if (env === 'staging') {
			return Uri.parse('https://stagingaccount.gitkraken.com');
		}

		if (env === 'dev') {
			return Uri.parse('https://devaccount.gitkraken.com');
		}

		return Uri.parse('https://account.gitkraken.com');
	}

	@memoize()
	private get baseSiteUri(): Uri {
		const { env } = this.container;
		if (env === 'staging') {
			return Uri.parse('https://staging.gitkraken.com');
		}

		if (env === 'dev') {
			return Uri.parse('https://dev.gitkraken.com');
		}

		return Uri.parse('https://gitkraken.com');
	}

	private get connectedKey(): `${WorkspaceStorageKeys.ConnectedPrefix}${string}` {
		return `${WorkspaceStorageKeys.ConnectedPrefix}gitkraken`;
	}

	private _etag: number = 0;
	get etag(): number {
		return this._etag;
	}

	private onReady() {
		this._disposable = Disposable.from(
			this._disposable,
			this.container.git.onDidChangeRepositories(this.onRepositoriesChanged, this),
			...this.registerCommands(),
		);
		this.updateContext();
	}

	private onRepositoriesChanged(_e: RepositoriesChangeEvent): void {
		this.updateContext();
	}

	private registerCommands(): Disposable[] {
		void this.container.viewCommands;

		return [
			commands.registerCommand(Commands.PremiumLearn, openToSide => this.learn(openToSide)),
			commands.registerCommand(Commands.PremiumLoginOrSignUp, () => this.loginOrSignUp()),
			commands.registerCommand(Commands.PremiumLogout, () => this.logout()),

			commands.registerCommand(Commands.PremiumStartPreviewTrial, () => this.startPreviewTrial()),
			commands.registerCommand(Commands.PremiumManage, () => this.manage()),
			commands.registerCommand(Commands.PremiumPurchase, () => this.purchase()),

			commands.registerCommand(Commands.PremiumResendVerification, () => this.resendVerification()),
			commands.registerCommand(Commands.PremiumValidate, () => this.validate()),

			commands.registerCommand(Commands.PremiumShowPlans, () => this.showPlans()),

			commands.registerCommand(Commands.PremiumHide, () =>
				configuration.updateEffective('premiumFeatures.enabled', false),
			),
			commands.registerCommand(Commands.PremiumRestore, () =>
				configuration.updateEffective('premiumFeatures.enabled', true),
			),

			commands.registerCommand('gitlens.premium.reset', () => this.logout(true)),
		];
	}

	async getSubscription(): Promise<Subscription> {
		void (await this.ensureSession(false));
		return this._subscription;
	}

	@debug()
	learn(openToSide: boolean = true): void {
		void openWalkthrough(this.container.context.extension.id, 'gitlens.premium', undefined, openToSide);
	}

	@gate()
	@log()
	async loginOrSignUp(): Promise<boolean> {
		if (!(await ensurePremiumFeaturesEnabled())) return false;

		void this.showHomeView();

		await this.container.storage.deleteWorkspace(this.connectedKey);

		const session = await this.ensureSession(true);
		const loggedIn = Boolean(session);
		if (loggedIn) {
			const {
				account,
				plan: { actual },
			} = this._subscription;

			if (account?.verified === false) {
				const confirm: MessageItem = { title: 'Resend Verification', isCloseAffordance: true };
				const cancel: MessageItem = { title: 'Cancel' };
				const result = await window.showInformationMessage(
					`Before you can access your ${actual.name} account, you must verify your email address.`,
					confirm,
					cancel,
				);

				if (result === confirm) {
					void this.resendVerification();
				}
			} else if (isSubscriptionTrial(this._subscription)) {
				const remaining = getSubscriptionTimeRemaining(this._subscription, 'days');

				const confirm: MessageItem = { title: 'OK', isCloseAffordance: true };
				const learn: MessageItem = { title: 'Learn More' };
				const result = await window.showInformationMessage(
					`You are now signed in to your ${
						actual.name
					} account which gives you access to premium features for public repos.\n\nYou were also granted a trial of premium features for both public and private repos for ${pluralize(
						'more day',
						remaining ?? 0,
					)}.`,
					{ modal: true },
					confirm,
					learn,
				);

				if (result === learn) {
					void this.learn();
				}
			} else {
				void window.showInformationMessage(`You are now signed in to your ${actual.name} account.`, 'OK');
			}
		}
		return loggedIn;
	}

	@gate()
	@log()
	logout(reset: boolean = false): void {
		this._sessionPromise = undefined;
		this._session = undefined;
		void this.container.storage.storeWorkspace(this.connectedKey, false);

		if (reset && this.container.debugging) {
			this.changeSubscription(undefined);

			return;
		}

		this.changeSubscription({
			...this._subscription,
			plan: {
				actual: getSubscriptionPlan(SubscriptionPlanId.Free),
				effective: getSubscriptionPlan(SubscriptionPlanId.Free),
			},
			account: undefined,
		});
	}

	@log()
	manage(): void {
		void env.openExternal(this.baseAccountUri);
	}

	@log()
	async purchase(): Promise<void> {
		if (!(await ensurePremiumFeaturesEnabled())) return;

		if (this._subscription.account == null) {
			void this.showPlans();
		} else {
			void env.openExternal(
				Uri.joinPath(this.baseAccountUri, 'create-organization').with({ query: 'product=gitlens' }),
			);
		}
		await this.showHomeView();
	}

	@gate()
	@log()
	async resendVerification(): Promise<void> {
		if (this._subscription.account?.verified) return;

		const cc = Logger.getCorrelationContext();

		void this.showHomeView(true);

		const session = await this.ensureSession(false);
		if (session == null) return;

		try {
			const rsp = await fetch(Uri.joinPath(this.baseApiUri, 'resend-email').toString(), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${session.accessToken}`,
					'User-Agent': userAgent,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ id: session.account.id }),
			});

			if (!rsp.ok) {
				debugger;
				Logger.error('', cc, `Unable to resend verification email; status=(${rsp.status}): ${rsp.statusText}`);

				void window.showErrorMessage(`Unable to resend verification email; Status: ${rsp.statusText}`, 'OK');

				return;
			}

			const confirm = { title: 'Recheck' };
			const cancel = { title: 'Cancel' };
			const result = await window.showInformationMessage(
				"Once you have verified your email address, click 'Recheck'.",
				confirm,
				cancel,
			);
			if (result === confirm) {
				await this.validate();
			}
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;

			void window.showErrorMessage('Unable to resend verification email', 'OK');
		}
	}

	@log()
	async showHomeView(silent: boolean = false): Promise<void> {
		if (silent && !configuration.get('premiumFeatures.enabled', undefined, true)) return;

		if (!this.container.homeView.visible) {
			await executeCommand(Commands.ShowHomeView);
		}
	}

	private showPlans(): void {
		void env.openExternal(Uri.joinPath(this.baseSiteUri, 'gitlens/pricing'));
	}

	@gate()
	@log()
	async startPreviewTrial(): Promise<void> {
		if (!(await ensurePremiumFeaturesEnabled())) return;

		let { plan, previewTrial } = this._subscription;
		if (previewTrial != null || plan.effective.id !== SubscriptionPlanId.Free) {
			void this.showHomeView();

			if (plan.effective.id === SubscriptionPlanId.Free) {
				const confirm: MessageItem = { title: 'Sign In', isCloseAffordance: true };
				const cancel: MessageItem = { title: 'Cancel' };
				const result = await window.showInformationMessage(
					'Your GitLens premium features trial has ended.\nPlease sign in to use premium features on public repos and get a free 7-day trial for both public and private repos.',
					{ modal: true },
					confirm,
					cancel,
				);

				if (result === confirm) {
					void this.loginOrSignUp();
				}
			}
			return;
		}

		const startedOn = new Date();

		let days;
		let expiresOn = new Date(startedOn);
		if (!this.container.debugging) {
			// Normalize the date to just before midnight on the same day
			expiresOn.setHours(23, 59, 59, 999);
			expiresOn = createFromDateDelta(expiresOn, { days: 3 });
			days = 3;
		} else {
			expiresOn = createFromDateDelta(expiresOn, { minutes: 1 });
			days = 0;
		}

		previewTrial = {
			startedOn: startedOn.toISOString(),
			expiresOn: expiresOn.toISOString(),
		};

		this.changeSubscription({
			...this._subscription,
			plan: {
				...this._subscription.plan,
				effective: getSubscriptionPlan(SubscriptionPlanId.Pro, startedOn, expiresOn),
			},
			previewTrial: previewTrial,
		});

		const confirm: MessageItem = { title: 'OK', isCloseAffordance: true };
		const learn: MessageItem = { title: 'Learn More' };
		const result = await window.showInformationMessage(
			`You have started a ${days} day trial of GitLens premium features for both public and private repos.`,
			{ modal: true },
			confirm,
			learn,
		);

		if (result === learn) {
			void this.learn();
		}
	}

	@gate()
	@log()
	async validate(): Promise<void> {
		const cc = Logger.getCorrelationContext();

		const session = await this.ensureSession(false);
		if (session == null) {
			this.changeSubscription(this._subscription);
			return;
		}

		try {
			await this.checkInAndValidate(session);
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
		}
	}

	private _lastCheckInDate: Date | undefined;
	@debug<SubscriptionService['checkInAndValidate']>({ args: { 0: s => s?.account.label } })
	private async checkInAndValidate(session: AuthenticationSession): Promise<void> {
		const cc = Logger.getCorrelationContext();

		try {
			const checkInData = {
				id: session.account.id,
				platform: getPlatform(),
				gitlensVersion: this.container.version,
				vscodeEdition: env.appName,
				vscodeHost: env.appHost,
				vscodeVersion: codeVersion,
				previewStartedOn: this._subscription.previewTrial?.startedOn,
				previewExpiresOn: this._subscription.previewTrial?.expiresOn,
			};

			const rsp = await fetch(Uri.joinPath(this.baseApiUri, 'gitlens/checkin').toString(), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${session.accessToken}`,
					'User-Agent': userAgent,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(checkInData),
			});

			if (!rsp.ok) {
				throw new AccountValidationError('Unable to validate account', undefined, rsp.status, rsp.statusText);
			}

			const data: GKLicenseInfo = await rsp.json();
			this.validateSubscription(data);
			this._lastCheckInDate = new Date();
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;
			if (ex instanceof AccountValidationError) throw ex;

			throw new AccountValidationError('Unable to validate account', ex);
		} finally {
			this.startDailyCheckInTimer();
		}
	}

	private _dailyCheckInTimer: ReturnType<typeof setInterval> | undefined;
	private startDailyCheckInTimer(): void {
		if (this._dailyCheckInTimer != null) {
			clearInterval(this._dailyCheckInTimer);
		}

		// Check twice a day to ensure we check in at least once a day
		this._dailyCheckInTimer = setInterval(() => {
			if (this._lastCheckInDate == null || this._lastCheckInDate.getDate() !== new Date().getDate()) {
				void this.ensureSession(false, true);
			}
		}, 1000 * 60 * 60 * 12);
	}

	@debug()
	private validateSubscription(data: GKLicenseInfo) {
		const account: Subscription['account'] = {
			id: data.user.id,
			name: data.user.name,
			email: data.user.email,
			verified: data.user.status === 'activated',
		};

		const effectiveLicenses = Object.entries(data.licenses.effectiveLicenses) as [GKLicenseType, GKLicense][];
		const paidLicenses = Object.entries(data.licenses.paidLicenses) as [GKLicenseType, GKLicense][];

		let actual: Subscription['plan']['actual'] | undefined;
		if (paidLicenses.length > 0) {
			paidLicenses.sort(
				(a, b) =>
					licenseStatusPriority(b[1].latestStatus) - licenseStatusPriority(a[1].latestStatus) ||
					getSubscriptionPlanPriority(convertLicenseTypeToPlanId(b[0])) -
						getSubscriptionPlanPriority(convertLicenseTypeToPlanId(a[0])),
			);

			const [licenseType, license] = paidLicenses[0];
			actual = getSubscriptionPlan(
				convertLicenseTypeToPlanId(licenseType),
				new Date(license.latestStartDate),
				new Date(license.latestEndDate),
			);
		}

		if (actual == null) {
			actual = getSubscriptionPlan(
				SubscriptionPlanId.FreePlus,
				data.user.firstGitLensCheckIn != null ? new Date(data.user.firstGitLensCheckIn) : undefined,
			);
		}

		let effective: Subscription['plan']['effective'] | undefined;
		if (effectiveLicenses.length > 0) {
			effectiveLicenses.sort(
				(a, b) =>
					licenseStatusPriority(b[1].latestStatus) - licenseStatusPriority(a[1].latestStatus) ||
					getSubscriptionPlanPriority(convertLicenseTypeToPlanId(b[0])) -
						getSubscriptionPlanPriority(convertLicenseTypeToPlanId(a[0])),
			);

			const [licenseType, license] = effectiveLicenses[0];
			effective = getSubscriptionPlan(
				convertLicenseTypeToPlanId(licenseType),
				new Date(license.latestStartDate),
				new Date(license.latestEndDate),
			);
		}

		if (effective == null) {
			effective = { ...actual };
		}

		this.changeSubscription({
			...this._subscription,
			plan: {
				actual: actual,
				effective: effective,
			},
			account: account,
		});
	}

	private _sessionPromise: Promise<AuthenticationSession | null> | undefined;
	private _session: AuthenticationSession | null | undefined;

	@gate()
	@debug()
	private async ensureSession(createIfNeeded: boolean, force?: boolean): Promise<AuthenticationSession | undefined> {
		if (this._sessionPromise != null && this._session === undefined) {
			this._session = await this._sessionPromise;
			this._sessionPromise = undefined;
		}

		if (!force && this._session != null) return this._session;
		if (this._session === null && !createIfNeeded) return undefined;

		if (createIfNeeded) {
			await this.container.storage.deleteWorkspace(this.connectedKey);
		} else if (this.container.storage.getWorkspace<boolean>(this.connectedKey) === false) {
			return undefined;
		}

		if (this._sessionPromise === undefined) {
			this._sessionPromise = this.getOrCreateSession(createIfNeeded);
		}

		this._session = await this._sessionPromise;
		this._sessionPromise = undefined;
		return this._session ?? undefined;
	}

	@debug()
	private async getOrCreateSession(createIfNeeded: boolean): Promise<AuthenticationSession | null> {
		const cc = Logger.getCorrelationContext();

		let session: AuthenticationSession | null | undefined;

		try {
			session = await authentication.getSession(
				SubscriptionService.authenticationProviderId,
				SubscriptionService.authenticationScopes,
				{
					createIfNone: createIfNeeded,
					silent: !createIfNeeded,
				},
			);
		} catch (ex) {
			session = null;

			if (ex instanceof Error && ex.message.includes('User did not consent')) {
				this.logout();
				return null;
			}

			Logger.error(ex, cc);
		}

		if (session == null) {
			this.logout();
			return session ?? null;
		}

		try {
			await this.checkInAndValidate(session);
		} catch (ex) {
			Logger.error(ex, cc);
			debugger;

			const name = session.account.label;
			session = null;
			if (ex instanceof AccountValidationError) {
				this.logout();

				if (createIfNeeded) {
					void window.showErrorMessage(
						`Unable to sign in to your account. Please try again. If this issue persists, please contact support. Account=${name} Error=${ex.message}`,
						'OK',
					);
				}
			}
		}

		return session;
	}

	@debug()
	private changeSubscription(
		subscription: Optional<Subscription, 'state'> | undefined,
		silent: boolean = false,
	): void {
		if (subscription == null) {
			subscription = {
				plan: {
					actual: getSubscriptionPlan(SubscriptionPlanId.Free),
					effective: getSubscriptionPlan(SubscriptionPlanId.Free),
				},
				account: undefined,
				state: SubscriptionState.Free,
			};
		}

		// If the effective plan is Free, then check if the preview has expired, if not apply it
		if (
			subscription.plan.effective.id === SubscriptionPlanId.Free &&
			subscription.previewTrial != null &&
			(getTimeRemaining(subscription.previewTrial.expiresOn) ?? 0) > 0
		) {
			(subscription.plan as PickMutable<Subscription['plan'], 'effective'>).effective = getSubscriptionPlan(
				SubscriptionPlanId.Pro,
				new Date(subscription.previewTrial.startedOn),
				new Date(subscription.previewTrial.expiresOn),
			);
		}

		// If the effective plan has expired, then replace it with the actual plan
		if (isSubscriptionExpired(subscription)) {
			(subscription.plan as PickMutable<Subscription['plan'], 'effective'>).effective = subscription.plan.actual;
		}

		subscription.state = computeSubscriptionState(subscription);
		assertSubscriptionState(subscription);
		void this.storeSubscription(subscription);

		const previous = this._subscription; // Can be undefined here, since we call this in the constructor
		this._subscription = subscription;

		this._etag = Date.now();
		this.updateContext();

		if (!silent && previous != null) {
			this._onDidChange.fire({ current: subscription, previous: previous, etag: this._etag });
		}
	}

	private getStoredSubscription(): Subscription | undefined {
		const storedSubscription = this.container.storage.get<Stored<Subscription>>(StorageKeys.PremiumSubscription);
		return storedSubscription?.data;
	}

	private async storeSubscription(subscription: Subscription): Promise<void> {
		return this.container.storage.store<Stored<Subscription>>(StorageKeys.PremiumSubscription, {
			v: 1,
			data: subscription,
		});
	}

	private updateContext(): void {
		void this.updateStatusBar();

		queueMicrotask(async () => {
			const { allowed, subscription } = await this.container.git.access();
			const required = allowed
				? false
				: subscription.required != null && isSubscriptionPaidPlan(subscription.required)
				? 'paid'
				: 'free+';
			void setContext(ContextKeys.PremiumAllowed, allowed);
			void setContext(ContextKeys.PremiumRequired, required);
		});

		const {
			plan: { actual },
			state,
		} = this._subscription;

		void setContext(ContextKeys.Premium, actual.id != SubscriptionPlanId.Free ? actual.id : undefined);
		void setContext(ContextKeys.PremiumState, state);
	}

	private updateStatusBar(): void {
		const {
			account,
			plan: { effective },
		} = this._subscription;

		if (effective.id === SubscriptionPlanId.Free) {
			this._statusBarSubscription?.dispose();
			this._statusBarSubscription = undefined;
			return;
		}

		const trial = isSubscriptionTrial(this._subscription);
		if (!trial && account?.verified !== false) {
			this._statusBarSubscription?.dispose();
			this._statusBarSubscription = undefined;
			return;
		}

		if (this._statusBarSubscription == null) {
			this._statusBarSubscription = window.createStatusBarItem(
				'gitlens.subscription',
				StatusBarAlignment.Left,
				1,
			);
		}

		this._statusBarSubscription.name = 'GitLens Subscription';
		this._statusBarSubscription.command = Commands.ShowHomeView;

		if (account?.verified === false) {
			this._statusBarSubscription.text = `$(warning) ${effective.name} (Unverified)`;
			this._statusBarSubscription.backgroundColor = new ThemeColor('statusBarItem.warningBackground');
			this._statusBarSubscription.tooltip = new MarkdownString(
				trial
					? `**Please verify your email**\n\nBefore you can start your **${effective.name}** trial, please verify the email for the account you created.\n\nClick for details`
					: `**Please verify your email**\n\nBefore you use premium GitLens features, please verify the email for the account you created.\n\nClick for details`,
				true,
			);
		} else {
			const remaining = getSubscriptionTimeRemaining(this._subscription, 'days');

			this._statusBarSubscription.text = `${effective.name} (Trial)`;
			this._statusBarSubscription.tooltip = new MarkdownString(
				`You are currently trialing **${
					effective.name
				}**, which gives you access to premium GitLens features. You have ${pluralize(
					'day',
					remaining ?? 0,
				)} remaining in your trial.\n\nClick for details`,
				true,
			);
		}

		this._statusBarSubscription.show();
	}
}

function assertSubscriptionState(subscription: Optional<Subscription, 'state'>): asserts subscription is Subscription {}

interface GKLicenseInfo {
	user: GKUser;
	licenses: {
		paidLicenses: Record<GKLicenseType, GKLicense>;
		effectiveLicenses: Record<GKLicenseType, GKLicense>;
	};
}

type GKLicenseType =
	| 'gitlens-pro'
	| 'gitlens-hosted-enterprise'
	| 'gitlens-self-hosted-enterprise'
	| 'gitlens-standalone-enterprise'
	| 'bundle-pro'
	| 'bundle-hosted-enterprise'
	| 'bundle-self-hosted-enterprise'
	| 'bundle-standalone-enterprise';

function convertLicenseTypeToPlanId(licenseType: GKLicenseType): SubscriptionPlanId {
	switch (licenseType) {
		case 'gitlens-pro':
		case 'bundle-pro':
			return SubscriptionPlanId.Pro;
		case 'gitlens-hosted-enterprise':
		case 'gitlens-self-hosted-enterprise':
		case 'gitlens-standalone-enterprise':
		case 'bundle-hosted-enterprise':
		case 'bundle-self-hosted-enterprise':
		case 'bundle-standalone-enterprise':
			return SubscriptionPlanId.Enterprise;
		default:
			return SubscriptionPlanId.FreePlus;
	}
}

function licenseStatusPriority(status: GKLicense['latestStatus']): number {
	switch (status) {
		case 'active':
			return 100;
		case 'expired':
			return -100;
		case 'trial':
			return 1;
		case 'canceled':
			return 0;
	}
}

interface GKLicense {
	latestStatus: 'active' | 'canceled' | 'expired' | 'trial';
	latestStartDate: string;
	latestEndDate: string;
}

interface GKUser {
	id: string;
	name: string;
	email: string;
	status: 'activated' | 'pending';
	firstGitLensCheckIn?: string;
}

interface Stored<T, SchemaVersion extends number = 1> {
	v: SchemaVersion;
	data: T;
}
