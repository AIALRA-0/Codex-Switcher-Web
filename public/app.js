const state = {
  csrf: '',
  runtime: null,
  publicConfig: {
    defaultUiLanguage: 'zh-CN',
    codeWorkspaceUrl: '',
    codeOrigin: ''
  },
  recentSwitches: [],
  recentSamples: [],
  switchLogPage: 1,
  sampleLogPage: 1,
  timeDisplayMode: 'server',
  uiLanguage: 'zh-CN',
  serverTimeZone: 'UTC',
  refreshTimer: null,
  eventSource: null,
  runtimeReloadTimer: null,
  runtimeReloadOptions: null,
  loadingRuntime: false,
  queuedRuntimeReload: false,
  queuedRuntimeReloadOptions: null,
  openBootstrapLogIds: new Set(),
  selectedAccountId: null,
  toastId: 0,
  accountPrivacyEnabled: false,
  sessionEmail: ''
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REFRESH_INTERVAL_MS = 30 * 1000;
const LOG_PAGE_SIZE = 5;
const TIME_DISPLAY_STORAGE_KEY = 'codex-switcher-time-display-mode';
const ACCOUNT_PRIVACY_STORAGE_KEY = 'codex-switcher-account-privacy-enabled';
const UI_LANGUAGE_STORAGE_KEY = 'codex-switcher-ui-language';
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;
const EMAIL_TEXT_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const DAY_MS = 24 * 60 * 60 * 1000;

const MESSAGES = {
  'zh-CN': {
    documentTitle: 'Codex Switcher',
    appEyebrow: 'Codex Account Console',
    appTitle: 'Codex 账号管理',
    languageToggle: '语言：中文',
    timeDisplayLocal: '时间显示：本地',
    timeDisplayServer: '时间显示：服务器',
    accountPrivacyOn: '账号隐私：开',
    accountPrivacyOff: '账号隐私：关',
    sessionLoggedOut: '未登录',
    logoutBackend: '退出后台',
    loginEyebrow: 'Admin Access',
    loginTitle: '管理员登录',
    emailLabel: '邮箱',
    passwordLabel: '密码',
    loginAction: '登录',
    loggingIn: '登录中...',
    loginSuccess: '登录成功',
    loggingOut: '退出中...',
    logoutSuccess: '已退出后台',
    dashboardTitle: '管理台',
    runtimeWaiting: '等待数据...',
    autoRefreshNote: '打开页面会立即刷新，页面保持打开时每 30 秒刷新一次',
    guideSave: '保存资料',
    guideAuth: '认证账号',
    guideSwitch: '切换使用',
    guideLogout: '退出留存',
    workspaceGuideTitle: '开始使用 code-server',
    workspaceGuideLead: '部署完成后，先打开工作区，再在 code-server 里开始对话。',
    workspaceGuideOpen: '打开工作区',
    workspaceGuideCopy: '复制工作区链接',
    workspaceGuideNoUrl: '当前部署还没有配置 code-server 工作区链接，请在安装时设置 CODE_WORKSPACE_URL。',
    workspaceGuideStepOpen: '1. 先打开 code-server 工作区链接。',
    workspaceGuideStepBundled: '2. 如果是首次进入且没有项目，请在 code-server 中选择“Open Folder”，打开 /workspace 或你自己的项目目录。',
    workspaceGuideStepExternal: '2. 如果是首次进入且没有项目，请在 code-server 中选择“Open Folder”，打开你想聊天/编码的项目目录。',
    workspaceGuideStepRefresh: '3. 切换账号后，如果 Codex / ChatGPT 侧栏仍显示旧状态，刷新一次 code-server 页面。',
    workspaceGuideStepChat: '4. 打开 OpenAI / Codex 扩展侧栏后即可开始对话。',
    currentUsageTitle: '当前使用',
    currentUsageHint: '只有点击“切换”时，code-server 的 Codex 才会换号',
    quotaSourceIdle: '等待同步',
    quotaSourceOnline: '后端同步正常',
    quotaSourceDegraded: '后端部分异常',
    quotaSourceError: '后端同步失败',
    accountsSectionTitle: '账号列表',
    accountsSectionHint: '每个账号都独立管理；先保存资料，再创建认证任务，然后打开认证页完成授权',
    accountIndexTitle: '账号索引',
    createAccount: '新建账号',
    logsSectionTitle: '最近记录',
    logsSectionHint: '这里只保留最近的切换与额度同步记录',
    switchLogsTitle: '切换记录',
    sampleLogsTitle: '额度快照',
    clearAction: '清除',
    prevPage: '上一页',
    nextPage: '下一页',
    switchLogPageAria: '切换记录页码',
    sampleLogPageAria: '额度快照页码',
    emptyPageInfo: '暂无记录',
    emptyEmail: '未填写邮箱',
    stateDraft: '待保存',
    stateActive: '当前活动',
    stateReady: '已认证',
    stateAuthRequired: '待认证',
    stateExhausted: '5 小时额度用尽',
    stateError: '异常',
    freshnessLive: '刚刚同步',
    freshnessStale: '等待刷新',
    freshnessPredicted: '预测值',
    bootstrapStarting: '准备中',
    bootstrapAwaitingUser: '等待认证',
    bootstrapVerifying: '校验身份中',
    bootstrapCaptured: '已完成',
    bootstrapFailed: '已失败',
    bootstrapRetrying: '重试中',
    operationFailed: '操作失败',
    invalidCredentials: '管理员邮箱或密码不正确',
    accountLocked: '登录尝试过多，请稍后再试',
    deviceAuthRateLimited: '设备码请求过于频繁，请等待一分钟后再试，或先删除当前认证任务',
    bootstrapAlreadyActive: '当前已经有其他账号在认证，请先完成或取消当前任务',
    activeAccountCannotDelete: '当前正在使用的账号不能删除，请先切换或退出',
    activeAccountMustExitFirst: '当前正在使用的账号不能直接修改邮箱或登录方式，请先退出',
    accountDataIncomplete: '请先把邮箱、登录方式和订阅到期日填写完整并保存',
    profileNotFound: '这个账号还没有服务器留存，请先认证',
    backendQuotaMissing: '后端暂时没有返回可用额度',
    backendWorkspaceDeactivated: '工作区已失效，后端暂时无法读取这个账号的实时额度',
    backendLoginExpired: '后端登录态已失效，暂时无法读取实时额度',
    summaryTotalAccounts: '账号总数',
    summaryAuthenticated: '已认证',
    summaryExpiringSoon: '即将到期',
    summaryBackendRefreshed: '后端已刷新',
    runtimeTimestamp: '最近一次刷新：{time}',
    activeEmptyTitle: '当前没有活动账号',
    activeEmptyHint: '当服务器上的 code-server 存在有效 Codex 登录态时，这里会自动识别并显示额度',
    activeAccountLabel: '当前账号',
    syncTimeLabel: '同步时间',
    accountIdLabel: 'account_id',
    planTypeLabel: '计划类型',
    backendRealtimeRead: '后端实时读取',
    backendSyncHealthy: '后端同步正常',
    backendSyncFailedCount: '有 {count} 个账号同步失败',
    authTaskTitle: '认证任务',
    authOpenHintEmail: '点击“打开认证页”即可进入 OpenAI 授权页，按邮箱登录方式完成授权。浏览器环境由你自己决定。',
    authOpenHintGoogle: '点击“打开认证页”即可进入 OpenAI 授权页，按 Google 登录方式完成授权。浏览器环境由你自己决定。',
    authCaptured: '认证完成，资料已写回服务器。',
    authVerifying: 'OpenAI 已授权，正在校验并接管服务器留存。',
    authGeneratingCode: '正在生成设备码，请稍等。',
    targetAccountLabel: '目标账号',
    deviceCodeLabel: '设备码',
    copyAction: '复制',
    openAuthPage: '打开认证页',
    copyAuthLink: '复制认证链接',
    regenerateDeviceCode: '重新生成设备码',
    reauthenticate: '重新认证',
    cancelAuth: '取消认证',
    viewLogs: '查看日志',
    noDeviceCodeYet: '暂未拿到设备码',
    updatedAt: '最近更新 {time}',
    quotaHeading: '额度',
    realtimeQuotaView: '实时剩余视图',
    quotaMissingRealtime: '后端暂时没有拿到实时额度，因此这里不会继续展示旧的历史值',
    subscriptionExpiryLabel: '订阅到期',
    lastSyncLabel: '最后同步',
    lastAuthLabel: '最后认证',
    errorLabel: '错误',
    stageSavedPending: '先保存资料',
    stageSavedDone: '资料已保存',
    stageAuthPending: '待认证',
    stageAuthActive: '认证进行中',
    stageAuthDone: '已完成认证',
    stageCurrentIdle: '未切换',
    stageCurrentActive: '当前正在使用',
    googleLogin: 'Google 登录',
    emailLogin: '邮箱登录',
    emptyNoAccountsTitle: '还没有账号',
    emptyNoAccountsHint: '点击“新建账号”开始录入邮箱、登录方式和到期日',
    emptySelectAccountTitle: '请选择一个账号',
    emptySelectAccountHint: '左侧点选账号后，这里会显示资料、额度和操作按钮',
    emptySwitchLogsTitle: '暂无切换记录',
    emptySwitchLogsHint: '点击账号卡片中的“切换”后，这里会留下记录',
    emptySampleLogsTitle: '暂无额度快照',
    emptySampleLogsHint: '页面加载后会立即刷新一次已认证账号的额度',
    switchInProgress: '进行中',
    switchCompleted: '已完成',
    switchFailed: '失败',
    switchReasonManual: '手动切换',
    switchReasonAuto: '自动切换',
    switchReasonCapture: '认证接管',
    quotaSyncSuccess: '同步成功',
    quotaSyncFailed: '同步失败',
    quotaSyncWaiting: '等待同步',
    saveAccountFirst: '资料已修改，下一步先保存',
    fillEmailFirst: '请先填写邮箱',
    invalidEmail: '邮箱格式不正确',
    selectLoginMethod: '请选择登录方式',
    setExpiryDate: '请设置订阅到期日',
    invalidExpiryDate: '订阅到期日格式不正确',
    hintFillAndSave: '先把资料填完整并保存',
    hintAuthInProgress: '认证任务已经在进行中，请先完成或删除当前任务',
    hintAuthBlocked: '当前正在认证 {email}，请先完成或删除该任务',
    hintDeviceCooldown: '设备码请求过于频繁，请等待到 {time} 后再试',
    hintNextAuth: '资料已保存，下一步创建认证任务',
    hintActiveReauth: '当前正在使用这个账号，如需更新服务器留存可重新认证',
    hintReady: '已经可以切换使用，也可以退出服务器留存',
    accountsSummary: '已认证 {authenticated} / 全部 {total} · 即将到期 {expiring} · 已到期 {expired}',
    switchFromTo: '从 {from} 切到 {to}',
    sourceUnknown: '来源未知',
    targetUnknown: '目标未知',
    planUnknown: '计划未知',
    untrackedAccount: '未归档账号',
    quotaWindow5h: '5 小时额度',
    quotaWindow1w: '1 周额度',
    quotaWindow5hShort: '5小时',
    quotaWindow1wShort: '1周',
    saveAction: '保存',
    switchAction: '切换',
    deleteAction: '删除',
    displayEmailLabel: '邮箱名称',
    currentStateLabel: '当前状态',
    loginMethodFieldLabel: '登录方式',
    subscriptionExpiryFieldLabel: '订阅到期日',
    accountPrivacyPlaceholder: '账号隐私已开启',
    copiedDeviceCode: '设备码 {code} 已复制',
    copiedTargetAccount: '目标账号 {email} 已复制',
    copiedAuthLink: '认证链接已复制',
    copiedWorkspaceLink: '工作区链接已复制',
    openedAuthLink: '认证链接已在新标签打开',
    inputValidPage: '请输入有效页码',
    copiedCreateHint: '已创建空白账号',
    accountSaved: '账号资料已保存',
    createdBootstrap: '认证任务已创建，直接打开认证页即可继续',
    restartedBootstrap: '新的设备码已生成，直接打开认证页即可继续',
    switchedToAccount: '已切换到 {name}',
    logoutServerRetained: '服务器留存已清除',
    deleteAccountConfirm: '确定删除 {label} 吗？这会同时删除服务器上保存的 profile、认证任务和临时认证文件',
    accountDeleted: '账号及后台留存已删除',
    bootstrapDeleted: '认证任务已清除',
    clearAllBootstrapConfirm: '确定一键清除全部 {count} 个认证任务吗？正在进行中的认证也会被终止',
    clearedBootstrapTasks: '已清除 {count} 个认证任务',
    clearSwitchLogsConfirm: '确定清空最近 {count} 条切换记录吗？这个操作不可恢复',
    clearSwitchLogsSuccess: '已清空 {count} 条切换记录',
    clearSampleLogsConfirm: '确定清空最近 {count} 条额度快照吗？这个操作不可恢复',
    clearSampleLogsSuccess: '已清空 {count} 条额度快照',
    resetTimeTitle: '重置时间',
    localTimeLabel: '本地时间',
    serverTimeLabel: '服务器时间',
    utcTimeLabel: 'UTC时间',
    remainingLabel: '剩余',
    usedSuffix: '已用',
    remainingApprox: '约剩余 {pct}%',
    noQuotaData: '后端暂时没有返回这项额度',
    quotaNoDataLine: '{label} 暂无可用数据',
    quotaLineDescription: '{label}已用 {used}，{remaining}，{reset} 重置',
    subscriptionUnset: '未设置到期日',
    subscriptionExpiredOn: '已于 {date} 到期',
    subscriptionExpiringIn: '{days} 天内到期',
    subscriptionValidUntil: '有效期至 {date}'
  },
  en: {
    documentTitle: 'Codex Switcher',
    appEyebrow: 'Codex Account Console',
    appTitle: 'Codex Account Manager',
    languageToggle: 'Language: English',
    timeDisplayLocal: 'Time: Local',
    timeDisplayServer: 'Time: Server',
    accountPrivacyOn: 'Account Privacy: On',
    accountPrivacyOff: 'Account Privacy: Off',
    sessionLoggedOut: 'Logged out',
    logoutBackend: 'Sign Out',
    loginEyebrow: 'Admin Access',
    loginTitle: 'Admin Sign In',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    loginAction: 'Sign In',
    loggingIn: 'Signing in...',
    loginSuccess: 'Signed in',
    loggingOut: 'Signing out...',
    logoutSuccess: 'Signed out',
    dashboardTitle: 'Control Panel',
    runtimeWaiting: 'Waiting for data...',
    autoRefreshNote: 'The page refreshes immediately on open and every 30 seconds while it stays open.',
    guideSave: 'Save details',
    guideAuth: 'Authenticate',
    guideSwitch: 'Switch',
    guideLogout: 'Log out',
    workspaceGuideTitle: 'Get Started with code-server',
    workspaceGuideLead: 'After deployment, open a workspace first, then start chatting inside code-server.',
    workspaceGuideOpen: 'Open Workspace',
    workspaceGuideCopy: 'Copy Workspace Link',
    workspaceGuideNoUrl: 'No code-server workspace URL is configured for this deployment yet. Set CODE_WORKSPACE_URL during install.',
    workspaceGuideStepOpen: '1. Open the code-server workspace link first.',
    workspaceGuideStepBundled: '2. If this is your first visit and no project is open, choose “Open Folder” in code-server and open /workspace or your own project folder.',
    workspaceGuideStepExternal: '2. If this is your first visit and no project is open, choose “Open Folder” in code-server and open the project folder you want to chat/code in.',
    workspaceGuideStepRefresh: '3. After switching accounts, refresh code-server once if the Codex / ChatGPT sidebar still shows the previous state.',
    workspaceGuideStepChat: '4. Open the OpenAI / Codex extension sidebar to start chatting.',
    currentUsageTitle: 'Current Usage',
    currentUsageHint: 'The Codex session inside code-server only changes when you click “Switch”.',
    quotaSourceIdle: 'Waiting',
    quotaSourceOnline: 'Backend healthy',
    quotaSourceDegraded: 'Backend partially degraded',
    quotaSourceError: 'Backend sync failed',
    accountsSectionTitle: 'Accounts',
    accountsSectionHint: 'Each account is managed independently: save details, create an auth task, then open the auth page to authorize.',
    accountIndexTitle: 'Account Index',
    createAccount: 'New Account',
    logsSectionTitle: 'Recent Activity',
    logsSectionHint: 'Only recent switch events and quota samples are kept here.',
    switchLogsTitle: 'Switch Events',
    sampleLogsTitle: 'Quota Samples',
    clearAction: 'Clear',
    prevPage: 'Previous',
    nextPage: 'Next',
    switchLogPageAria: 'Switch log pagination',
    sampleLogPageAria: 'Quota sample pagination',
    emptyPageInfo: 'No records',
    emptyEmail: 'Email not set',
    stateDraft: 'Draft',
    stateActive: 'Active',
    stateReady: 'Authenticated',
    stateAuthRequired: 'Needs Auth',
    stateExhausted: '5h quota exhausted',
    stateError: 'Error',
    freshnessLive: 'Just synced',
    freshnessStale: 'Waiting for refresh',
    freshnessPredicted: 'Predicted',
    bootstrapStarting: 'Preparing',
    bootstrapAwaitingUser: 'Waiting for auth',
    bootstrapVerifying: 'Verifying identity',
    bootstrapCaptured: 'Completed',
    bootstrapFailed: 'Failed',
    bootstrapRetrying: 'Retrying',
    operationFailed: 'Action failed',
    invalidCredentials: 'Invalid admin email or password',
    accountLocked: 'Too many login attempts. Please try again later.',
    deviceAuthRateLimited: 'Device-code requests are rate-limited. Wait about one minute or clear the current auth task first.',
    bootstrapAlreadyActive: 'Another account is already being authenticated. Finish or cancel that task first.',
    activeAccountCannotDelete: 'The active account cannot be deleted. Switch away or log it out first.',
    activeAccountMustExitFirst: 'The active account must be logged out before changing email or login method.',
    accountDataIncomplete: 'Fill in email, login method, and expiry date before continuing.',
    profileNotFound: 'This account does not have a saved server profile yet. Authenticate it first.',
    backendQuotaMissing: 'The backend did not return usable quota data yet.',
    backendWorkspaceDeactivated: 'The workspace is deactivated, so the backend cannot read live quota for this account right now.',
    backendLoginExpired: 'The backend login has expired, so live quota cannot be read right now.',
    summaryTotalAccounts: 'Total Accounts',
    summaryAuthenticated: 'Authenticated',
    summaryExpiringSoon: 'Expiring Soon',
    summaryBackendRefreshed: 'Backend Refreshed',
    runtimeTimestamp: 'Last refresh: {time}',
    activeEmptyTitle: 'No active account',
    activeEmptyHint: 'When code-server has a valid Codex login, this panel will detect it and show live quota automatically.',
    activeAccountLabel: 'Current account',
    syncTimeLabel: 'Synced at',
    accountIdLabel: 'account_id',
    planTypeLabel: 'Plan type',
    backendRealtimeRead: 'Read live from backend',
    backendSyncHealthy: 'Backend sync healthy',
    backendSyncFailedCount: '{count} accounts failed to sync',
    authTaskTitle: 'Auth Task',
    authOpenHintEmail: 'Use “Open Auth Page” to continue on the OpenAI authorization page with email sign-in. The browser environment is entirely up to you.',
    authOpenHintGoogle: 'Use “Open Auth Page” to continue on the OpenAI authorization page with Google sign-in. The browser environment is entirely up to you.',
    authCaptured: 'Authentication finished and the profile has been saved on the server.',
    authVerifying: 'OpenAI authorization succeeded. Validating identity and capturing the server-side profile now.',
    authGeneratingCode: 'Generating a device code. Please wait.',
    targetAccountLabel: 'Target account',
    deviceCodeLabel: 'Device code',
    copyAction: 'Copy',
    openAuthPage: 'Open Auth Page',
    copyAuthLink: 'Copy Auth Link',
    regenerateDeviceCode: 'Regenerate Device Code',
    reauthenticate: 'Re-authenticate',
    cancelAuth: 'Cancel Auth',
    viewLogs: 'View Logs',
    noDeviceCodeYet: 'No device code yet',
    updatedAt: 'Updated {time}',
    quotaHeading: 'Quota',
    realtimeQuotaView: 'Live remaining view',
    quotaMissingRealtime: 'The backend has not returned live quota yet, so old historical values are hidden.',
    subscriptionExpiryLabel: 'Subscription expiry',
    lastSyncLabel: 'Last sync',
    lastAuthLabel: 'Last auth',
    errorLabel: 'Error',
    stageSavedPending: 'Save details',
    stageSavedDone: 'Details saved',
    stageAuthPending: 'Needs auth',
    stageAuthActive: 'Auth in progress',
    stageAuthDone: 'Authenticated',
    stageCurrentIdle: 'Not switched',
    stageCurrentActive: 'Currently in use',
    googleLogin: 'Google sign-in',
    emailLogin: 'Email sign-in',
    emptyNoAccountsTitle: 'No accounts yet',
    emptyNoAccountsHint: 'Click “New Account” to add email, login method, and expiry date.',
    emptySelectAccountTitle: 'Select an account',
    emptySelectAccountHint: 'Choose an account on the left to view details, quota, and actions here.',
    emptySwitchLogsTitle: 'No switch events yet',
    emptySwitchLogsHint: 'Switch an account from its card and the event will appear here.',
    emptySampleLogsTitle: 'No quota samples yet',
    emptySampleLogsHint: 'Authenticated accounts are refreshed once immediately after the page loads.',
    switchInProgress: 'In progress',
    switchCompleted: 'Completed',
    switchFailed: 'Failed',
    switchReasonManual: 'Manual switch',
    switchReasonAuto: 'Auto switch',
    switchReasonCapture: 'Auth capture',
    quotaSyncSuccess: 'Synced',
    quotaSyncFailed: 'Sync failed',
    quotaSyncWaiting: 'Waiting',
    saveAccountFirst: 'Details changed. Save them first.',
    fillEmailFirst: 'Enter an email first',
    invalidEmail: 'Enter a valid email address',
    selectLoginMethod: 'Choose a login method',
    setExpiryDate: 'Set the subscription expiry date',
    invalidExpiryDate: 'Enter the expiry date in a valid format',
    hintFillAndSave: 'Complete the details and save first',
    hintAuthInProgress: 'An auth task is already in progress for this account. Finish or cancel it first.',
    hintAuthBlocked: '{email} is currently being authenticated. Finish or cancel that task first.',
    hintDeviceCooldown: 'Device-code requests are cooling down. Try again after {time}.',
    hintNextAuth: 'Details are saved. Create an auth task next.',
    hintActiveReauth: 'This account is currently in use. Re-authenticate it if you want to refresh the saved profile.',
    hintReady: 'This account is ready to switch, or you can log it out from the server.',
    accountsSummary: '{authenticated} authenticated / {total} total · {expiring} expiring soon · {expired} expired',
    switchFromTo: 'Switch from {from} to {to}',
    sourceUnknown: 'Unknown source',
    targetUnknown: 'Unknown target',
    planUnknown: 'Unknown plan',
    untrackedAccount: 'Untracked account',
    quotaWindow5h: '5h Quota',
    quotaWindow1w: '1w Quota',
    quotaWindow5hShort: '5h',
    quotaWindow1wShort: '1w',
    saveAction: 'Save',
    switchAction: 'Switch',
    deleteAction: 'Delete',
    displayEmailLabel: 'Display Email',
    currentStateLabel: 'Current State',
    loginMethodFieldLabel: 'Login Method',
    subscriptionExpiryFieldLabel: 'Subscription Expiry',
    accountPrivacyPlaceholder: 'Account privacy is enabled',
    copiedDeviceCode: 'Copied device code {code}',
    copiedTargetAccount: 'Copied target account {email}',
    copiedAuthLink: 'Copied auth link',
    copiedWorkspaceLink: 'Copied workspace link',
    openedAuthLink: 'Opened the auth link in a new tab',
    inputValidPage: 'Enter a valid page number',
    copiedCreateHint: 'Created a blank account',
    accountSaved: 'Account details saved',
    createdBootstrap: 'Auth task created. Open the auth page to continue.',
    restartedBootstrap: 'A new device code is ready. Open the auth page to continue.',
    switchedToAccount: 'Switched to {name}',
    logoutServerRetained: 'Cleared the saved server profile',
    deleteAccountConfirm: 'Delete {label}? This also removes the saved server profile, auth tasks, and temporary auth files.',
    accountDeleted: 'Account and saved backend state deleted',
    bootstrapDeleted: 'Auth task cleared',
    clearAllBootstrapConfirm: 'Clear all {count} auth tasks? Any in-progress authentication will also be stopped.',
    clearedBootstrapTasks: 'Cleared {count} auth tasks',
    clearSwitchLogsConfirm: 'Clear the most recent {count} switch events? This cannot be undone.',
    clearSwitchLogsSuccess: 'Cleared {count} switch events',
    clearSampleLogsConfirm: 'Clear the most recent {count} quota samples? This cannot be undone.',
    clearSampleLogsSuccess: 'Cleared {count} quota samples',
    resetTimeTitle: 'Reset time',
    localTimeLabel: 'Local',
    serverTimeLabel: 'Server',
    utcTimeLabel: 'UTC',
    remainingLabel: 'Remaining',
    usedSuffix: 'used',
    remainingApprox: 'about {pct}% left',
    noQuotaData: 'The backend has not returned quota data for this window yet.',
    quotaNoDataLine: '{label} has no data yet',
    quotaLineDescription: '{label}: {used} used, {remaining}, resets {reset}',
    subscriptionUnset: 'Expiry not set',
    subscriptionExpiredOn: 'Expired on {date}',
    subscriptionExpiringIn: 'Expires in {days} day(s)',
    subscriptionValidUntil: 'Valid until {date}'
  }
};

function currentUiLanguage() {
  return state.uiLanguage === 'en' ? 'en' : 'zh-CN';
}

function uiLocale() {
  return currentUiLanguage() === 'en' ? 'en-US' : 'zh-CN';
}

function t(key, vars = {}) {
  const lang = currentUiLanguage();
  const catalog = MESSAGES[lang] || MESSAGES['zh-CN'];
  const fallback = MESSAGES['zh-CN'] || {};
  const value = catalog[key] ?? fallback[key] ?? key;
  if (typeof value === 'function') {
    return value(vars);
  }
  return String(value).replace(/\{(\w+)\}/g, (_match, name) => {
    const resolved = vars[name];
    return resolved == null ? '' : String(resolved);
  });
}

function stripAnsi(text) {
  return String(text || '').replace(ANSI_PATTERN, '');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlMultiline(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function extractDeviceCode(text) {
  const match = stripAnsi(text).match(/\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/);
  return match ? match[1] : '';
}

function shortId(value) {
  if (!value) return '--';
  const text = String(value);
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function isAccountPrivacyEnabled() {
  return state.accountPrivacyEnabled === true;
}

function looksLikeEmail(value) {
  return EMAIL_PATTERN.test(String(value || '').trim());
}

function maskEmail(value) {
  const text = String(value || '').trim();
  if (!text) return '*****';
  const [localPart, domainPart = ''] = text.split('@');
  const domainParts = domainPart.split('.');
  const domainLabel = domainParts.shift() || '';
  const suffix = domainParts.length ? `.${domainParts.join('.')}` : '';
  const maskSegment = (segment) => {
    const normalized = String(segment || '').trim();
    if (!normalized) return '*****';
    return `${normalized.slice(0, 1)}*****`;
  };
  if (!domainPart) return maskSegment(localPart);
  return `${maskSegment(localPart)}@${maskSegment(domainLabel)}${suffix}`;
}

function displayEmailValue(value, options = {}) {
  const text = String(value || '').trim();
  const fallback = options.fallback || '--';
  if (!text) return fallback;
  if (options.reveal === true || !isAccountPrivacyEnabled()) return text;
  return looksLikeEmail(text) ? maskEmail(text) : text;
}

function maskEmailsInText(value) {
  return String(value || '').replace(EMAIL_TEXT_PATTERN, (match) => displayEmailValue(match));
}

function displayAccountName(account) {
  if (!account) return t('emptyEmail');
  const email = typeof account === 'string' ? account : account.email;
  return displayEmailValue(email, { fallback: t('emptyEmail') });
}

function stateLabel(account) {
  const mapping = {
    draft: t('stateDraft'),
    active: t('stateActive'),
    ready: t('stateReady'),
    auth_required: t('stateAuthRequired'),
    exhausted: t('stateExhausted'),
    error: t('stateError')
  };
  return mapping[account.display_state] || account.display_state || '--';
}

function stateTone(value) {
  const mapping = {
    draft: 'unknown',
    active: 'healthy',
    ready: 'healthy',
    auth_required: 'warning',
    exhausted: 'danger',
    error: 'danger'
  };
  return mapping[value] || 'unknown';
}

function freshnessLabel(value) {
  const mapping = {
    live: t('freshnessLive'),
    stale: t('freshnessStale'),
    predicted: t('freshnessPredicted')
  };
  return mapping[value] || value || t('freshnessStale');
}

function currentTimeMode() {
  return state.timeDisplayMode === 'local' ? 'local' : 'server';
}

function timeZoneLabelFor(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      timeZoneName: 'short'
    }).formatToParts(date);
    return parts.find((part) => part.type === 'timeZoneName')?.value || '';
  } catch (_) {
    return '';
  }
}

function formatAbsoluteDate(value, options = {}) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const includeSeconds = options.includeSeconds === true;
  const baseOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(includeSeconds ? { second: '2-digit' } : {})
  };

  if (options.mode === 'local') {
    const localText = new Intl.DateTimeFormat(uiLocale(), baseOptions).format(date);
    const zoneLabel = timeZoneLabelFor(date);
    return zoneLabel ? `${localText} ${zoneLabel}` : localText;
  }

  const zone = options.mode === 'server' ? (state.serverTimeZone || 'UTC') : 'UTC';
  const text = new Intl.DateTimeFormat(uiLocale(), {
    ...baseOptions,
    timeZone: zone
  }).format(date);
  const zoneLabel = options.mode === 'server'
    ? (timeZoneLabelFor(date, zone) || zone)
    : 'UTC';
  return `${text} ${zoneLabel}`;
}

function formatTimestampLines(value, options = {}) {
  if (!value) return '--';
  const includeSeconds = options.includeSeconds === true;
  const lines = [];
  if (currentTimeMode() === 'local') {
    lines.push(`${t('localTimeLabel')} ${formatAbsoluteDate(value, {
      mode: 'local',
      includeSeconds
    })}`);
  }
  lines.push(`${t('serverTimeLabel')} ${formatAbsoluteDate(value, {
    mode: 'server',
    includeSeconds
  })}`);
  lines.push(`${t('utcTimeLabel')} ${formatAbsoluteDate(value, {
    mode: 'utc',
    includeSeconds
  })}`);
  return lines.join('\n');
}

function formatTimestamp(value, options = {}) {
  const primary = formatAbsoluteDate(value, {
    mode: currentTimeMode() === 'local' ? 'local' : 'server',
    includeSeconds: options.includeSeconds !== false
  });
  if (!options.includeUtc || currentTimeMode() !== 'local') return primary;
  return `${primary}\n${formatAbsoluteDate(value, {
    mode: 'utc',
    includeSeconds: options.includeSeconds !== false
  })}`;
}

function formatUtcTimestamp(value, options = {}) {
  return formatAbsoluteDate(value, {
    mode: 'utc',
    includeSeconds: options.includeSeconds !== false
  });
}

function displayResetLabel(resetLabel, resetAt, options = {}) {
  if (resetAt) {
    return formatTimestamp(resetAt, {
      includeSeconds: false,
      includeUtc: options.includeUtc === true
    });
  }
  return resetLabel || '--';
}

function buildResetTimeBlock(resetLabel, resetAt) {
  if (!resetAt) {
    return `${t('resetTimeTitle')}\n${t('serverTimeLabel')} ${resetLabel || '--'}\n${t('utcTimeLabel')} ${resetLabel || '--'}`;
  }
  return `${t('resetTimeTitle')}\n${formatTimestampLines(resetAt, { includeSeconds: false })}`;
}

function syncTimeDisplayButton() {
  const button = document.getElementById('timeDisplayToggleBtn');
  if (!button) return;
  button.textContent = currentTimeMode() === 'local' ? t('timeDisplayLocal') : t('timeDisplayServer');
}

function syncAccountPrivacyButton() {
  const button = document.getElementById('accountPrivacyToggleBtn');
  if (!button) return;
  button.textContent = isAccountPrivacyEnabled() ? t('accountPrivacyOn') : t('accountPrivacyOff');
}

function syncLanguageButton() {
  const button = document.getElementById('languageToggleBtn');
  if (!button) return;
  button.textContent = t('languageToggle');
}

function bootstrapStatusText(status) {
  const mapping = {
    starting: t('bootstrapStarting'),
    awaiting_user: t('bootstrapAwaitingUser'),
    success_pending_capture: t('bootstrapVerifying'),
    succeeded: t('bootstrapVerifying'),
    captured: t('bootstrapCaptured'),
    failed: t('bootstrapFailed'),
    retrying_wrong_account: t('bootstrapRetrying')
  };
  return mapping[status] || status || '--';
}

function bootstrapStatusTone(status) {
  if (status === 'captured') return 'healthy';
  if (status === 'failed') return 'expired';
  if (status === 'success_pending_capture' || status === 'succeeded') return 'warning';
  return 'warning';
}

async function startBootstrapTask(slotId, options = {}) {
  const result = await api(
    options.restart === true
      ? `/api/accounts/${slotId}/bootstrap/restart`
      : `/api/accounts/${slotId}/bootstrap`,
    {
    method: 'POST',
    body: '{}'
    }
  );
  scheduleRuntimeReload(10, { fast: true, includeLogs: false });
  scheduleRuntimeReload(220);
  return result;
}

function mergeLoadOptions(current = {}, incoming = {}) {
  const safeCurrent = current && typeof current === 'object' ? current : {};
  const safeIncoming = incoming && typeof incoming === 'object' ? incoming : {};
  const currentFast = safeCurrent.fast === true;
  const incomingFast = safeIncoming.fast === true;
  const currentIncludeLogs = safeCurrent.includeLogs === false ? false : true;
  const incomingIncludeLogs = safeIncoming.includeLogs === false ? false : true;
  return {
    fast: currentFast && incomingFast,
    includeLogs: currentIncludeLogs && incomingIncludeLogs
  };
}

function scheduleRuntimeReload(delay = 0, options = {}) {
  if (state.runtimeReloadTimer) window.clearTimeout(state.runtimeReloadTimer);
  state.runtimeReloadOptions = mergeLoadOptions(state.runtimeReloadOptions, options);
  state.runtimeReloadTimer = window.setTimeout(() => {
    state.runtimeReloadTimer = null;
    const nextOptions = state.runtimeReloadOptions || {};
    state.runtimeReloadOptions = null;
    loadRuntime(nextOptions).catch(console.error);
  }, delay);
}

function activeDeviceAuthCooldown() {
  const cooldown = state.runtime && state.runtime.deviceAuthCooldown ? state.runtime.deviceAuthCooldown : null;
  if (!cooldown || !cooldown.expires_at) return null;
  const expiresAt = new Date(cooldown.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
  return cooldown;
}

function isActiveBootstrapStatus(status) {
  return ['starting', 'awaiting_user', 'success_pending_capture', 'succeeded'].includes(status);
}

function activeBootstrapSession() {
  const sessions = state.runtime && Array.isArray(state.runtime.bootstrapSessions) ? state.runtime.bootstrapSessions : [];
  return sessions.find((session) => isActiveBootstrapStatus(session.status)) || null;
}

function subscriptionTone(status) {
  if (status === 'healthy') return 'healthy';
  if (status === 'warning') return 'warning';
  if (status === 'expired') return 'expired';
  return 'unknown';
}

function quotaTone(pct) {
  if (pct == null) return 'empty';
  const remaining = quotaRemainingPct(pct);
  if (remaining == null) return 'empty';
  if (remaining <= 10) return 'danger';
  if (remaining <= 30) return 'warning';
  return 'healthy';
}

function quotaValueText(pct) {
  return pct == null ? '--' : `${pct}%`;
}

function quotaRemainingPct(pct) {
  if (pct == null) return null;
  return Math.max(0, 100 - pct);
}

function quotaRemainingText(pct) {
  const remaining = quotaRemainingPct(pct);
  if (remaining == null) return `${t('remainingLabel')} --`;
  return t('remainingApprox', { pct: `${remaining}` });
}

function quotaRgb(pct) {
  const tone = quotaTone(pct);
  if (tone === 'healthy') return [18, 122, 72];
  if (tone === 'warning') return [198, 110, 18];
  if (tone === 'danger') return [211, 47, 47];
  return [148, 163, 184];
}

function quotaGaugeColor(pct) {
  const [r, g, b] = quotaRgb(pct);
  return `rgb(${r}, ${g}, ${b})`;
}

function quotaSurfaceColor(pct) {
  const tone = quotaTone(pct);
  if (tone === 'healthy') return 'linear-gradient(180deg, #ebfaf1 0%, #ffffff 100%)';
  if (tone === 'warning') return 'linear-gradient(180deg, #fff6e8 0%, #fffdf8 100%)';
  if (tone === 'danger') return 'linear-gradient(180deg, #fff1f1 0%, #ffffff 100%)';
  return 'linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)';
}

function quotaBorderColor(pct) {
  const [r, g, b] = quotaRgb(pct);
  return `rgba(${r}, ${g}, ${b}, 0.24)`;
}

function quotaSoftColor(pct, alpha = 0.18) {
  const [r, g, b] = quotaRgb(pct);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function quotaSignalValue(pct) {
  const remaining = quotaRemainingPct(pct);
  return remaining == null ? '--' : `${remaining}%`;
}

function buildQuotaSignal(label, pct) {
  return `
    <div class="quota-signal ${quotaTone(pct)}" title="${escapeHtml(buildQuotaSignalTitle(label, pct))}">
      <span class="quota-signal__lamp" aria-hidden="true"></span>
      <span class="quota-signal__label">${label}</span>
      <strong>${quotaSignalValue(pct)}</strong>
    </div>
  `;
}

function logStateItems(kind) {
  return kind === 'switch' ? (state.recentSwitches || []) : (state.recentSamples || []);
}

function renderLogKind(kind) {
  if (kind === 'switch') renderSwitchLogs(logStateItems('switch'));
  else renderSampleLogs(logStateItems('sample'));
}

function jumpToLogPage(kind) {
  const input = document.getElementById(kind === 'switch' ? 'switchLogJumpInput' : 'sampleLogJumpInput');
  const items = logStateItems(kind);
  if (!input || !items.length) return;
  const raw = Number(input.value);
  if (!Number.isFinite(raw) || raw < 1) {
    showToast(t('inputValidPage'), 'warning');
    input.focus();
    return;
  }
  const totalPages = totalLogPages(items);
  const targetPage = Math.min(totalPages, Math.max(1, Math.trunc(raw)));
  if (kind === 'switch') state.switchLogPage = targetPage;
  else state.sampleLogPage = targetPage;
  renderLogKind(kind);
}

function buildQuotaSignalTitle(label, pct) {
  if (pct == null) return t('quotaNoDataLine', { label });
  return t('quotaLineDescription', {
    label,
    used: quotaValueText(pct),
    remaining: quotaRemainingText(pct),
    reset: '--'
  });
}

function quotaGaugeTrackColor(pct) {
  return quotaSoftColor(pct, 0.18);
}

function buildGaugeSvg(pct, compact = false) {
  const remaining = quotaRemainingPct(pct);
  const progress = remaining == null ? 0 : Math.max(0, Math.min(100, remaining));
  const center = 80;
  const radius = compact ? 53 : 60;
  const angle = ((progress / 100) * 360) - 90;
  const radians = (angle * Math.PI) / 180;
  const markerX = center + Math.cos(radians) * radius;
  const markerY = center + Math.sin(radians) * radius;
  const gaugeColor = quotaGaugeColor(pct);
  const trackColor = quotaGaugeTrackColor(pct);

  return `
    <svg class="quota-gauge__svg" viewBox="0 0 160 160" aria-hidden="true" focusable="false">
      <circle class="quota-gauge__track" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${trackColor}"></circle>
      <circle
        class="quota-gauge__progress"
        cx="${center}"
        cy="${center}"
        r="${radius}"
        pathLength="100"
        fill="none"
        stroke="${gaugeColor}"
        stroke-dasharray="${progress.toFixed(2)} 100"
        stroke-dashoffset="0"
        transform="rotate(-90 ${center} ${center})"
      ></circle>
      ${remaining == null ? '' : `<circle class="quota-gauge__marker" cx="${markerX.toFixed(2)}" cy="${markerY.toFixed(2)}" r="${compact ? 5.5 : 6.5}" fill="${gaugeColor}"></circle>`}
    </svg>
  `;
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

function humanizeBackendError(rawText) {
  const text = String(rawText || '');
  if (!text) return t('backendQuotaMissing');
  if (/deactivated_workspace/i.test(text)) return t('backendWorkspaceDeactivated');
  if (/WHAM_REQUEST_FAILED_401/i.test(text)) return t('backendLoginExpired');
  const match = text.match(/backend_usage_fetch_failed :: (.+)$/i);
  return maskEmailsInText(match ? match[1] : text);
}

function slotLabelById(slotId) {
  if (!slotId) return t('untrackedAccount');
  const slots = state.runtime && Array.isArray(state.runtime.slots) ? state.runtime.slots : [];
  const slot = slots.find((item) => item.id === slotId);
  if (!slot) return slotId;
  return displayAccountName(slot);
}

function slotMetaById(slotId) {
  if (!slotId) return '';
  const slots = state.runtime && Array.isArray(state.runtime.slots) ? state.runtime.slots : [];
  const slot = slots.find((item) => item.id === slotId);
  if (!slot) return slotId;
  return slot.login_method === 'google' ? t('googleLogin') : t('emailLogin');
}

function switchStatusLabel(status) {
  const mapping = {
    starting: t('switchInProgress'),
    completed: t('switchCompleted'),
    failed: t('switchFailed')
  };
  return mapping[status] || status || '--';
}

function switchStatusTone(status) {
  if (status === 'completed') return 'healthy';
  if (status === 'failed') return 'expired';
  return 'warning';
}

function switchReasonLabel(reason) {
  const mapping = {
    manual_switch: t('switchReasonManual'),
    auto_switch: t('switchReasonAuto'),
    bootstrap_capture: t('switchReasonCapture')
  };
  return mapping[reason] || reason || '--';
}

function quotaSyncStatusLabel(status) {
  if (status === 'ok') return t('quotaSyncSuccess');
  if (status === 'error') return t('quotaSyncFailed');
  return t('quotaSyncWaiting');
}

function quotaSyncStatusTone(status) {
  if (status === 'ok') return 'healthy';
  if (status === 'error') return 'expired';
  return 'warning';
}

function quotaLineDescription(label, pct, resetLabel, resetAt) {
  if (pct == null) return t('quotaNoDataLine', { label });
  return t('quotaLineDescription', {
    label,
    used: quotaValueText(pct),
    remaining: quotaRemainingText(pct),
    reset: displayResetLabel(resetLabel, resetAt, { includeUtc: true })
  });
}

function buildQuotaGaugeCard(label, pct, resetLabel, resetAt, options = {}) {
  const remaining = quotaRemainingPct(pct);
  const tone = quotaTone(pct);
  const usedText = pct == null ? `${t('usedSuffix')} --` : `${quotaValueText(pct)} ${t('usedSuffix')}`;
  const note = pct == null
    ? t('noQuotaData')
    : buildResetTimeBlock(resetLabel, resetAt);
  return `
    <article class="quota-gauge-card ${options.compact ? 'quota-gauge-card--compact' : 'quota-gauge-card--hero'} ${tone}">
      <div class="quota-gauge-card__head">
        <div class="quota-gauge__title">${label}</div>
        <div class="quota-gauge__used">${usedText}</div>
      </div>
      <div class="quota-gauge-card__body">
        <div class="quota-gauge">
          ${buildGaugeSvg(pct, options.compact)}
          <div class="quota-gauge__inner">
            <strong>${remaining == null ? '--' : `${remaining}%`}</strong>
            <small>${t('remainingLabel')}</small>
          </div>
        </div>
      </div>
      <div class="quota-gauge__meta">
        <div class="quota-gauge__note">${escapeHtmlMultiline(note)}</div>
      </div>
    </article>
  `;
}

function totalLogPages(items) {
  return Math.max(1, Math.ceil(items.length / LOG_PAGE_SIZE));
}

function paginateLogs(items, page) {
  const totalPages = totalLogPages(items);
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * LOG_PAGE_SIZE;
  return {
    items: items.slice(start, start + LOG_PAGE_SIZE),
    currentPage,
    totalPages
  };
}

function updateLogPager(kind, totalItems, currentPage, totalPages) {
  const prevButton = document.getElementById(kind === 'switch' ? 'switchLogPrevBtn' : 'sampleLogPrevBtn');
  const nextButton = document.getElementById(kind === 'switch' ? 'switchLogNextBtn' : 'sampleLogNextBtn');
  const pageInfo = document.getElementById(kind === 'switch' ? 'switchLogPageInfo' : 'sampleLogPageInfo');
  const pageText = document.getElementById(kind === 'switch' ? 'switchLogPageText' : 'sampleLogPageText');
  const pageMeta = document.getElementById(kind === 'switch' ? 'switchLogPageMeta' : 'sampleLogPageMeta');
  const clearButton = document.getElementById(kind === 'switch' ? 'clearSwitchLogsBtn' : 'clearSampleLogsBtn');
  const jumpInput = document.getElementById(kind === 'switch' ? 'switchLogJumpInput' : 'sampleLogJumpInput');
  if (!prevButton || !nextButton || !pageInfo || !pageText || !pageMeta || !clearButton) return;
  prevButton.disabled = totalItems === 0 || currentPage <= 1;
  nextButton.disabled = totalItems === 0 || currentPage >= totalPages;
  clearButton.disabled = totalItems === 0;
  pageInfo.classList.toggle('disabled', totalItems === 0);
  pageInfo.dataset.totalPages = String(totalPages);
  pageInfo.dataset.currentPage = String(currentPage);
  pageText.textContent = totalItems === 0 ? t('emptyPageInfo') : `${currentPage} / ${totalPages}`;
  pageMeta.textContent = totalItems === 0 ? '' : (currentUiLanguage() === 'en' ? `${totalItems} total` : `共 ${totalItems} 条`);
  if (jumpInput) {
    jumpInput.disabled = totalItems === 0;
    jumpInput.min = '1';
    jumpInput.max = String(totalPages);
    jumpInput.placeholder = totalItems === 0 ? '--' : String(currentPage);
    jumpInput.value = totalItems === 0 ? '' : String(currentPage);
  }
  setLogPageEditMode(kind, false);
}

function setLogPageEditMode(kind, editing) {
  const pageInfo = document.getElementById(kind === 'switch' ? 'switchLogPageInfo' : 'sampleLogPageInfo');
  const pageText = document.getElementById(kind === 'switch' ? 'switchLogPageText' : 'sampleLogPageText');
  const pageMeta = document.getElementById(kind === 'switch' ? 'switchLogPageMeta' : 'sampleLogPageMeta');
  const jumpInput = document.getElementById(kind === 'switch' ? 'switchLogJumpInput' : 'sampleLogJumpInput');
  if (!pageInfo || !pageText || !pageMeta || !jumpInput || pageInfo.classList.contains('disabled')) return;
  pageInfo.classList.toggle('is-editing', editing);
  pageText.classList.toggle('hidden', editing);
  pageMeta.classList.toggle('hidden', editing);
  jumpInput.classList.toggle('hidden', !editing);
  if (editing) {
    jumpInput.focus();
    jumpInput.select();
  }
}

function showToast(message, tone = 'success') {
  const viewport = document.getElementById('toastViewport');
  if (!viewport) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${tone}`;
  toast.dataset.toastId = String(++state.toastId);
  toast.textContent = message;
  viewport.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('toast--closing');
    window.setTimeout(() => toast.remove(), 180);
  }, 2200);
}

function setButtonBusy(button, pendingText) {
  if (!button) return () => {};
  const previousDisabled = button.disabled;
  const originalText = button.dataset.originalText || button.textContent;
  button.dataset.originalText = originalText;
  button.disabled = true;
  button.classList.add('is-busy');
  if (pendingText) button.textContent = pendingText;
  return () => {
    if (!button.isConnected) return;
    button.disabled = previousDisabled;
    button.classList.remove('is-busy');
    button.textContent = originalText;
  };
}

function explainError(error) {
  if (!error || !error.message) return t('operationFailed');
  if (error.message === 'INVALID_CREDENTIALS') return t('invalidCredentials');
  if (error.message === 'ACCOUNT_LOCKED') return t('accountLocked');
  if (error.message === 'DEVICE_AUTH_RATE_LIMITED') return t('deviceAuthRateLimited');
  if (error.message === 'BOOTSTRAP_ALREADY_ACTIVE') {
    const currentPendingBootstrap = activeBootstrapSession();
    return t('hintAuthBlocked', {
      email: displayEmailValue(currentPendingBootstrap && currentPendingBootstrap.email, { fallback: '--' })
    });
  }
  if (error.message === 'ACTIVE_ACCOUNT_CANNOT_BE_DELETED') return t('activeAccountCannotDelete');
  if (error.message === 'ACTIVE_ACCOUNT_MUST_EXIT_FIRST') return t('activeAccountMustExitFirst');
  if (error.message === 'ACCOUNT_DATA_INCOMPLETE') return t('accountDataIncomplete');
  if (error.message === 'PROFILE_NOT_FOUND') return t('profileNotFound');
  return maskEmailsInText(error.message);
}

async function runButtonAction(button, options, action) {
  const restore = setButtonBusy(button, options.pendingText);
  try {
    const result = await action();
    if (options.successText) {
      showToast(typeof options.successText === 'function' ? options.successText(result) : options.successText, 'success');
    }
    return result;
  } catch (error) {
    if (options.refreshOnError) {
      await loadRuntime().catch(() => {});
    }
    showToast(typeof options.errorText === 'function' ? options.errorText(error) : (options.errorText || explainError(error)), 'error');
    throw error;
  } finally {
    restore();
  }
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (!state.csrf && method !== 'GET' && method !== 'HEAD') {
    await refreshCsrf().catch(() => {});
  }
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.error || `Request failed: ${response.status}`);
  }
  return json;
}

async function refreshCsrf() {
  const json = await fetch('/api/csrf', { credentials: 'include' }).then((res) => res.json());
  state.csrf = json.token;
}

function setSessionBadge(text) {
  const value = String(text || '').trim();
  if (value && value !== t('sessionLoggedOut')) state.sessionEmail = value;
  document.getElementById('sessionBadge').textContent = displayEmailValue(value, { fallback: value || '--' });
}

function formatDateOnly(value) {
  const raw = String(value || '').trim();
  if (!raw) return '--';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T23:59:59.999Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(uiLocale(), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function buildSubscriptionLabel(account) {
  const raw = String(account && account.expires_at || '').trim();
  if (!raw) return t('subscriptionUnset');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T23:59:59.999Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return t('subscriptionUnset');
  const diffMs = date.getTime() - Date.now();
  const daysRemaining = Math.ceil(diffMs / DAY_MS);
  const displayDate = formatDateOnly(raw);
  if (diffMs < 0) return t('subscriptionExpiredOn', { date: displayDate });
  if (daysRemaining <= 3) return t('subscriptionExpiringIn', { days: daysRemaining });
  return t('subscriptionValidUntil', { date: displayDate });
}

function currentWorkspaceUrl() {
  return String(state.publicConfig && state.publicConfig.codeWorkspaceUrl || '').trim();
}

function currentWorkspaceDefaultFolder() {
  const url = currentWorkspaceUrl();
  if (!url) return '';
  try {
    return new URL(url).searchParams.get('folder') || '';
  } catch (_) {
    return '';
  }
}

function renderWorkspaceGuide() {
  const host = document.getElementById('workspaceGuideHost');
  if (!host) return;
  const workspaceUrl = currentWorkspaceUrl();
  const defaultFolder = currentWorkspaceDefaultFolder();
  const folderHint = defaultFolder === '/workspace'
    ? t('workspaceGuideStepBundled')
    : t('workspaceGuideStepExternal');

  host.innerHTML = `
    <section class="workspace-banner">
      <div class="workspace-banner__copy">
        <strong>${t('workspaceGuideTitle')}</strong>
        <p class="muted">${workspaceUrl ? t('workspaceGuideLead') : t('workspaceGuideNoUrl')}</p>
        ${workspaceUrl ? `
          <div class="workspace-guide-grid">
            <p>${t('workspaceGuideStepOpen')}</p>
            <p>${folderHint}</p>
            <p>${t('workspaceGuideStepRefresh')}</p>
            <p>${t('workspaceGuideStepChat')}</p>
          </div>
        ` : ''}
      </div>
      ${workspaceUrl ? `
        <div class="workspace-banner__actions">
          <a class="primary workspace-banner__link" href="${escapeHtml(workspaceUrl)}" target="_blank" rel="noopener">${t('workspaceGuideOpen')}</a>
          <button type="button" class="ghost" id="copyWorkspaceLinkBtn">${t('workspaceGuideCopy')}</button>
        </div>
      ` : ''}
    </section>
  `;

  const copyButton = document.getElementById('copyWorkspaceLinkBtn');
  if (!copyButton) return;
  copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(workspaceUrl);
      showToast(t('copiedWorkspaceLink'), 'success');
    } catch (_) {
      showToast(workspaceUrl, 'warning');
    }
  };
}

function applyStaticTranslations() {
  document.documentElement.lang = currentUiLanguage();
  document.title = t('documentTitle');
  const textMap = {
    appEyebrow: 'appEyebrow',
    appTitle: 'appTitle',
    loginEyebrow: 'loginEyebrow',
    loginTitle: 'loginTitle',
    loginEmailLabel: 'emailLabel',
    loginPasswordLabel: 'passwordLabel',
    loginSubmitBtn: 'loginAction',
    dashboardTitle: 'dashboardTitle',
    autoRefreshNote: 'autoRefreshNote',
    guideStepSave: 'guideSave',
    guideStepAuth: 'guideAuth',
    guideStepSwitch: 'guideSwitch',
    guideStepLogout: 'guideLogout',
    activeSectionTitle: 'currentUsageTitle',
    activeSectionHint: 'currentUsageHint',
    accountsSectionTitle: 'accountsSectionTitle',
    accountsSectionHint: 'accountsSectionHint',
    accountIndexTitle: 'accountIndexTitle',
    createAccountBtn: 'createAccount',
    logsSectionTitle: 'logsSectionTitle',
    logsSectionHint: 'logsSectionHint',
    switchLogsTitle: 'switchLogsTitle',
    sampleLogsTitle: 'sampleLogsTitle',
    clearSwitchLogsBtn: 'clearAction',
    clearSampleLogsBtn: 'clearAction',
    switchLogPrevBtn: 'prevPage',
    switchLogNextBtn: 'nextPage',
    sampleLogPrevBtn: 'prevPage',
    sampleLogNextBtn: 'nextPage',
    logoutBtn: 'logoutBackend'
  };
  Object.entries(textMap).forEach(([id, key]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = t(key);
  });
  const switchPager = document.getElementById('switchLogPageInfo');
  if (switchPager) switchPager.setAttribute('aria-label', t('switchLogPageAria'));
  const samplePager = document.getElementById('sampleLogPageInfo');
  if (samplePager) samplePager.setAttribute('aria-label', t('sampleLogPageAria'));
  const runtimeTimestamp = document.getElementById('runtimeTimestamp');
  if (runtimeTimestamp && !state.runtime) runtimeTimestamp.textContent = t('runtimeWaiting');
  const quotaSourceBadge = document.getElementById('quotaSourceBadge');
  if (quotaSourceBadge && !state.runtime) quotaSourceBadge.textContent = t('quotaSourceIdle');
  const switchLogPageText = document.getElementById('switchLogPageText');
  if (switchLogPageText && !(state.recentSwitches || []).length) switchLogPageText.textContent = t('emptyPageInfo');
  const sampleLogPageText = document.getElementById('sampleLogPageText');
  if (sampleLogPageText && !(state.recentSamples || []).length) sampleLogPageText.textContent = t('emptyPageInfo');
  syncLanguageButton();
  syncTimeDisplayButton();
  syncAccountPrivacyButton();
  renderWorkspaceGuide();
}

function renderSummary(runtime) {
  const summary = runtime.summary || {};
  const source = runtime.quotaSource || {};
  document.getElementById('summaryGrid').innerHTML = `
    <article class="stat-card">
      <span class="stat-label">${t('summaryTotalAccounts')}</span>
      <strong class="stat-value">${summary.totalAccounts || 0}</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">${t('summaryAuthenticated')}</span>
      <strong class="stat-value">${summary.authenticatedAccounts || 0}</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">${t('summaryExpiringSoon')}</span>
      <strong class="stat-value">${summary.expiringSoon || 0}</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">${t('summaryBackendRefreshed')}</span>
      <strong class="stat-value">${source.refreshedCount == null ? '--' : source.refreshedCount}</strong>
    </article>
  `;
}

function renderRuntimeTimestamp(nowIso) {
  document.getElementById('runtimeTimestamp').innerHTML = escapeHtml(t('runtimeTimestamp', {
    time: formatUtcTimestamp(nowIso, { includeSeconds: true })
  }));
}

function renderActiveSlot(runtime) {
  const node = document.getElementById('activeSlotCard');
  const badge = document.getElementById('quotaSourceBadge');
  const active = runtime.activeSlot;
  const source = runtime.quotaSource || {};

  badge.textContent = source.state === 'online'
    ? t('quotaSourceOnline')
    : source.state === 'degraded'
      ? t('quotaSourceDegraded')
      : source.state === 'error'
        ? t('quotaSourceError')
        : t('quotaSourceIdle');
  badge.className = `inline-badge ${source.state || 'idle'}`;

  if (!active) {
    node.innerHTML = `
      <div class="active-empty">
        <strong>${t('activeEmptyTitle')}</strong>
        <p class="muted">${t('activeEmptyHint')}</p>
      </div>
    `;
    return;
  }

  node.innerHTML = `
    <div class="active-card">
      <div class="active-card__top">
        <div>
          <div class="active-card__label">${t('activeAccountLabel')}</div>
          <h4>${displayAccountName(active)}</h4>
          <p class="muted">${displayEmailValue(active.email, { fallback: '--' })} · ${stateLabel(active)}</p>
        </div>
        <div class="status-pill ${stateTone(active.display_state)}">${stateLabel(active)}</div>
      </div>
      <div class="quota-gauge-grid quota-gauge-grid--hero">
        ${buildQuotaGaugeCard(t('quotaWindow5h'), active.quota_5h_pct, active.quota_5h_reset_label, active.quota_5h_reset_at)}
        ${buildQuotaGaugeCard(t('quotaWindow1w'), active.quota_week_pct, active.quota_week_reset_label, active.quota_week_reset_at)}
      </div>
      <div class="active-card__facts">
        <div class="fact-tile">
          <span>${t('syncTimeLabel')}</span>
          <strong>${escapeHtml(formatUtcTimestamp(active.last_seen_at, { includeSeconds: true }))}</strong>
          <small>${source.message || t('backendRealtimeRead')}</small>
        </div>
        <div class="fact-tile">
          <span>${t('accountIdLabel')}</span>
          <strong class="mono" title="${active.account_id || '--'}">${shortId(active.account_id)}</strong>
          <small>${freshnessLabel(active.freshness)}</small>
        </div>
        <div class="fact-tile">
          <span>${t('planTypeLabel')}</span>
          <strong>${source.planType || '--'}</strong>
          <small>${source.failedCount ? t('backendSyncFailedCount', { count: source.failedCount }) : t('backendSyncHealthy')}</small>
        </div>
      </div>
    </div>
  `;
}

function renderBootstrapSessions(sessions) {
  const node = document.getElementById('bootstrapList');
  const clearButton = document.getElementById('clearBootstrapTasksBtn');
  if (clearButton) {
    clearButton.classList.add('hidden');
    clearButton.disabled = sessions.length === 0;
  }
  if (!node) return;
  node.innerHTML = '';
}

function latestBootstrapSessionForSlot(slotId) {
  const sessions = state.runtime && Array.isArray(state.runtime.bootstrapSessions)
    ? state.runtime.bootstrapSessions
    : [];
  return sessions.find((session) => session.slot_id === slotId) || null;
}

function bootstrapMessageText(account, session) {
  if (!session) return '';
  if (session.error_text) return maskEmailsInText(session.error_text);
  if (session.status === 'captured') return t('authCaptured');
  if (session.status === 'success_pending_capture' || session.status === 'succeeded') return t('authVerifying');
  if (session.status === 'starting') return t('authGeneratingCode');
  return account.login_method === 'google' ? t('authOpenHintGoogle') : t('authOpenHintEmail');
}

function buildInlineAuthProgress(account) {
  const session = latestBootstrapSessionForSlot(account.id);
  if (!session) return '';

  const deviceCode = session
    ? (session.device_code || extractDeviceCode(session.log_tail || '') || '')
    : '';
  const authOpenUrl = session.auth_open_url || '';
  const targetEmail = account.email || session.email || '';
  const message = bootstrapMessageText(account, session);
  const restartLabel = session.status === 'failed' ? t('reauthenticate') : t('regenerateDeviceCode');

  return `
    <section class="account-auth-card">
      <div class="account-auth-card__top">
        <div class="account-auth-card__title">
          <h5>${t('authTaskTitle')}</h5>
          <p class="muted">${escapeHtml(message)}</p>
        </div>
        <div class="account-auth-card__actions">
          <span class="status-pill ${bootstrapStatusTone(session.status)}">${escapeHtml(bootstrapStatusText(session.status))}</span>
        </div>
      </div>
      ${targetEmail ? `
        <div class="account-auth-code-row">
          <span class="muted">${t('targetAccountLabel')}</span>
          <button type="button" class="device-code-chip inline-copy-target-email" data-target-email="${escapeHtml(targetEmail)}">
            <span class="mono">${escapeHtml(targetEmail)}</span>
            <span>${t('copyAction')}</span>
          </button>
        </div>
      ` : ''}
      <div class="account-auth-code-row">
        <span class="muted">${t('deviceCodeLabel')}</span>
        ${deviceCode
          ? `
            <button type="button" class="device-code-chip inline-copy-device-code" data-device-code="${deviceCode}">
              <span class="mono">${deviceCode}</span>
              <span>${t('copyAction')}</span>
            </button>
          `
          : `<span class="device-code-empty">${t('noDeviceCodeYet')}</span>`}
        <span class="muted">${t('updatedAt', { time: escapeHtml(formatTimestamp(session.updated_at)) })}</span>
      </div>
      <div class="account-auth-card__actions">
        ${authOpenUrl ? `<button type="button" class="secondary inline-open-auth-link" data-auth-open-url="${escapeHtml(authOpenUrl)}">${t('openAuthPage')}</button>` : ''}
        ${authOpenUrl ? `<button type="button" class="ghost inline-copy-auth-link" data-auth-open-url="${escapeHtml(authOpenUrl)}">${t('copyAuthLink')}</button>` : ''}
        <button type="button" class="ghost inline-restart-bootstrap" data-slot-id="${account.id}">${restartLabel}</button>
        <button type="button" class="danger inline-delete-bootstrap-task" data-bootstrap-id="${session.id}">${t('cancelAuth')}</button>
      </div>
      ${session && session.error_text ? `<div class="account-auth-error">${escapeHtml(maskEmailsInText(session.error_text))}</div>` : ''}
      ${session.log_tail ? `
        <details class="task-details" data-bootstrap-id="${session.id}" ${state.openBootstrapLogIds.has(session.id) ? 'open' : ''}>
          <summary>${t('viewLogs')}</summary>
          <pre>${stripAnsi(session.log_tail)}</pre>
        </details>
      ` : ''}
    </section>
  `;
}

function progressMarkup(label, pct, resetLabel) {
  return `
    <div class="quota-line ${quotaTone(pct)}">
      <div class="quota-line__top">
        <span>${label}</span>
        <strong>${quotaValueText(pct)}</strong>
      </div>
      <div class="quota-line__meta">${pct == null ? t('noQuotaData') : `${quotaRemainingText(pct)} · ${resetLabel} ${t('resetTimeTitle')}`}</div>
    </div>
  `;
}

function buildQuotaPanel(account) {
  const quotaNote = account.precise
    ? ''
    : account.last_error
      ? humanizeBackendError(account.last_error)
      : t('quotaMissingRealtime');
  return `
    <div class="quota-block__head">
      <strong>${t('quotaHeading')}</strong>
      <span class="status-pill ${account.precise ? 'healthy' : 'unknown'}">${account.precise ? t('realtimeQuotaView') : freshnessLabel(account.freshness)}</span>
    </div>
    <div class="quota-gauge-grid quota-gauge-grid--compact">
      ${buildQuotaGaugeCard(t('quotaWindow5h'), account.quota_5h_pct, account.quota_5h_reset_label, account.quota_5h_reset_at)}
      ${buildQuotaGaugeCard(t('quotaWindow1w'), account.quota_week_pct, account.quota_week_reset_label, account.quota_week_reset_at)}
    </div>
    ${quotaNote ? `<div class="quota-note quota-note--warning">${escapeHtml(quotaNote)}</div>` : ''}
  `;
}

function buildMetaGrid(account) {
  const errorMarkup = account.last_error && account.last_error !== '--'
    ? `<div class="fact-row fact-row--error"><span>${t('errorLabel')}</span><strong>${escapeHtml(humanizeBackendError(account.last_error))}</strong></div>`
    : '';
  return `
    <div class="fact-row">
      <span>${t('subscriptionExpiryLabel')}</span>
      <strong>${buildSubscriptionLabel(account)}</strong>
    </div>
    <div class="fact-row">
      <span>${t('lastSyncLabel')}</span>
      <strong>${escapeHtml(formatUtcTimestamp(account.last_seen_at, { includeSeconds: true }))}</strong>
    </div>
    <div class="fact-row">
      <span>${t('lastAuthLabel')}</span>
      <strong>${escapeHtml(formatUtcTimestamp(account.last_bootstrap_at, { includeSeconds: true }))}</strong>
    </div>
    <div class="fact-row">
      <span>${t('accountIdLabel')}</span>
      <strong class="mono" title="${account.account_id || '--'}">${shortId(account.account_id)}</strong>
    </div>
    ${errorMarkup}
  `;
}

function stageChip(tone, text) {
  return `<span class="stage-chip ${tone}">${text}</span>`;
}

function buildStageStrip(account) {
  const savedReady = validateAccountFields({
    email: account.email || '',
    login_method: account.login_method || '',
    expires_at: account.expires_at || '',
    label: account.email || ''
  }).valid;

  return `
    ${stageChip(savedReady ? 'done' : 'pending', savedReady ? t('stageSavedDone') : t('stageSavedPending'))}
    ${stageChip(account.has_pending_bootstrap ? 'active' : account.has_profile ? 'done' : 'pending', account.has_pending_bootstrap ? t('stageAuthActive') : account.has_profile ? t('stageAuthDone') : t('stageAuthPending'))}
    ${stageChip(account.is_active ? 'active' : 'idle', account.is_active ? t('stageCurrentActive') : t('stageCurrentIdle'))}
  `;
}

function sortAccounts(accounts) {
  const severity = { expired: 0, warning: 1, healthy: 2, unknown: 3 };
  return [...accounts].sort((a, b) => {
    if (!!a.is_active !== !!b.is_active) return a.is_active ? -1 : 1;
    if (!!a.has_profile !== !!b.has_profile) return a.has_profile ? -1 : 1;
    const sa = severity[a.subscription_status] ?? 9;
    const sb = severity[b.subscription_status] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(displayAccountName(a) || a.id).localeCompare(String(displayAccountName(b) || b.id), currentUiLanguage() === 'en' ? 'en' : 'zh-CN');
  });
}

function isClientAccountDraft(slot) {
  return !String(slot.email || '').trim()
    || !String(slot.login_method || '').trim()
    || !String(slot.expires_at || '').trim();
}

function deriveClientDisplayState(slot) {
  if (slot.is_active) return 'active';
  if (isClientAccountDraft(slot)) return 'draft';
  if (!slot.has_profile) return 'auth_required';
  if (slot.state === 'error' && slot.last_error) return 'error';
  if (slot.quota_5h_pct >= 100 && slot.quota_5h_reset_at && new Date(slot.quota_5h_reset_at).getTime() > Date.now()) return 'exhausted';
  return 'ready';
}

function syncClientPendingBootstrapFlags() {
  if (!state.runtime || !Array.isArray(state.runtime.slots)) return;
  const sessions = Array.isArray(state.runtime.bootstrapSessions) ? state.runtime.bootstrapSessions : [];
  const pendingSlotIds = new Set(
    sessions
      .filter((session) => isActiveBootstrapStatus(session.status))
      .map((session) => session.slot_id)
  );
  state.runtime.slots.forEach((slot) => {
    slot.has_pending_bootstrap = pendingSlotIds.has(slot.id);
    slot.display_state = deriveClientDisplayState(slot);
  });
}

function renderRuntimeState(options = {}) {
  if (!state.runtime) return;
  renderRuntimeTimestamp(state.runtime.now || new Date().toISOString());
  renderSummary(state.runtime);
  renderActiveSlot(state.runtime);
  renderBootstrapSessions(state.runtime.bootstrapSessions || []);
  renderAccountsSummary(state.runtime);
  renderAccounts(state.runtime.slots || []);
  if (options.includeLogs !== false) {
    renderSwitchLogs(state.recentSwitches || []);
    renderSampleLogs(state.recentSamples || []);
  }
}

function mutateRuntime(mutator, options = {}) {
  if (!state.runtime) return;
  mutator(state.runtime);
  state.runtime.now = new Date().toISOString();
  syncClientPendingBootstrapFlags();
  renderRuntimeState(options);
}

function optimisticBootstrapStart(result) {
  if (!state.runtime || !result || !result.bootstrapSession) return;
  const session = {
    ...result.bootstrapSession,
    auth_open_url: result.authOpenUrl || ''
  };
  mutateRuntime((runtime) => {
    const sessions = Array.isArray(runtime.bootstrapSessions) ? runtime.bootstrapSessions : [];
    runtime.bootstrapSessions = [session, ...sessions.filter((item) => item.id !== session.id && item.slot_id !== session.slot_id)];
    const slot = (runtime.slots || []).find((item) => item.id === session.slot_id);
    if (slot) {
      slot.last_error = null;
      slot.state = 'auth_required';
    }
  }, { includeLogs: false });
}

function optimisticBootstrapDelete(bootstrapId) {
  if (!state.runtime || !bootstrapId) return;
  mutateRuntime((runtime) => {
    const sessions = Array.isArray(runtime.bootstrapSessions) ? runtime.bootstrapSessions : [];
    const target = sessions.find((item) => item.id === bootstrapId);
    runtime.bootstrapSessions = sessions.filter((item) => item.id !== bootstrapId);
    if (target) {
      const slot = (runtime.slots || []).find((item) => item.id === target.slot_id);
      if (slot) {
        slot.last_error = null;
        slot.state = slot.has_profile ? 'ready' : 'auth_required';
      }
    }
  }, { includeLogs: false });
}

function normalizeFieldValue(name, value) {
  const normalized = String(value || '').trim();
  if (name === 'email') return normalized.toLowerCase();
  return normalized;
}

function readCardFieldSnapshot(card) {
  const values = {};
  card.querySelectorAll('[data-field]').forEach((field) => {
    values[field.dataset.field] = normalizeFieldValue(field.dataset.field, field.value);
  });
  values.label = values.email || '';
  return values;
}

function readSavedFieldSnapshot(card) {
  return {
    email: normalizeFieldValue('email', card.dataset.savedEmail || ''),
    login_method: normalizeFieldValue('login_method', card.dataset.savedLoginMethod || 'email'),
    expires_at: normalizeFieldValue('expires_at', card.dataset.savedExpiresAt || ''),
    label: normalizeFieldValue('label', card.dataset.savedEmail || '')
  };
}

function isCardDirty(card) {
  const current = readCardFieldSnapshot(card);
  const saved = readSavedFieldSnapshot(card);
  return ['email', 'login_method', 'expires_at'].some((key) => current[key] !== saved[key]);
}

function validateAccountFields(snapshot) {
  const errors = [];
  if (!snapshot.email) errors.push(t('fillEmailFirst'));
  else if (!EMAIL_PATTERN.test(snapshot.email)) errors.push(t('invalidEmail'));
  if (!snapshot.login_method || !['email', 'google'].includes(snapshot.login_method)) errors.push(t('selectLoginMethod'));
  if (!snapshot.expires_at) errors.push(t('setExpiryDate'));
  else if (!DATE_PATTERN.test(snapshot.expires_at)) errors.push(t('invalidExpiryDate'));
  return {
    valid: errors.length === 0,
    errors
  };
}

function isSavedSnapshotReady(card) {
  return validateAccountFields(readSavedFieldSnapshot(card)).valid;
}

function syncFieldValidity(card, showInvalid) {
  const snapshot = readCardFieldSnapshot(card);
  card.querySelectorAll('[data-field]').forEach((field) => {
    const name = field.dataset.field;
    let invalid = false;
    if (name === 'email') invalid = !snapshot.email || !EMAIL_PATTERN.test(snapshot.email);
    if (name === 'login_method') invalid = !snapshot.login_method || !['email', 'google'].includes(snapshot.login_method);
    if (name === 'expires_at') invalid = !snapshot.expires_at || !DATE_PATTERN.test(snapshot.expires_at);
    const visibleInvalid = showInvalid && invalid;
    field.classList.toggle('field-invalid', visibleInvalid);
    field.setAttribute('aria-invalid', visibleInvalid ? 'true' : 'false');
  });
}

function flowHintText(card) {
  const draft = readCardFieldSnapshot(card);
  const draftValidation = validateAccountFields(draft);
  const dirty = isCardDirty(card);
  const savedReady = isSavedSnapshotReady(card);
  const hasProfile = card.dataset.hasProfile === '1';
  const hasPendingBootstrap = card.dataset.hasPendingBootstrap === '1';
  const isActive = card.dataset.isActive === '1';
  const cooldown = activeDeviceAuthCooldown();
  const currentPendingBootstrap = activeBootstrapSession();
  const blockedByOtherBootstrap = currentPendingBootstrap && currentPendingBootstrap.slot_id !== card.dataset.accountId;

  if (dirty && !draftValidation.valid) return `${draftValidation.errors[0]}`;
  if (dirty) return t('saveAccountFirst');
  if (!savedReady) return t('hintFillAndSave');
  if (hasPendingBootstrap) return t('hintAuthInProgress');
  if (blockedByOtherBootstrap) {
    return t('hintAuthBlocked', {
      email: displayEmailValue(currentPendingBootstrap.email, { fallback: '--' })
    });
  }
  if (cooldown) return t('hintDeviceCooldown', { time: formatTimestamp(cooldown.expires_at) });
  if (!hasProfile) return t('hintNextAuth');
  if (isActive) return t('hintActiveReauth');
  return t('hintReady');
}

function updateAccountCardState(card) {
  const draft = readCardFieldSnapshot(card);
  const draftValidation = validateAccountFields(draft);
  const dirty = isCardDirty(card);
  const savedReady = isSavedSnapshotReady(card);
  const hasProfile = card.dataset.hasProfile === '1';
  const hasPendingBootstrap = card.dataset.hasPendingBootstrap === '1';
  const isActive = card.dataset.isActive === '1';
  const cooldown = activeDeviceAuthCooldown();
  const currentPendingBootstrap = activeBootstrapSession();
  const blockedByOtherBootstrap = currentPendingBootstrap && currentPendingBootstrap.slot_id !== card.dataset.accountId;

  const saveButton = card.querySelector('.save-account');
  const authButton = card.querySelector('.bootstrap-account');
  const switchButton = card.querySelector('.switch-account');
  const logoutButton = card.querySelector('.logout-account');
  const deleteButton = card.querySelector('.delete-account');
  const flowNode = card.querySelector('.flow-hint');

  const canSave = dirty && draftValidation.valid;
  const canAuth = !dirty && savedReady && !hasPendingBootstrap && !blockedByOtherBootstrap && !cooldown;
  const canSwitch = !dirty && savedReady && hasProfile && !isActive;
  const canLogout = !dirty && savedReady && hasProfile;
  const canDelete = !dirty && !isActive;

  saveButton.disabled = !canSave;
  authButton.disabled = !canAuth;
  switchButton.disabled = !canSwitch;
  logoutButton.disabled = !canLogout;
  deleteButton.disabled = !canDelete;
  authButton.textContent = hasProfile ? t('reauthenticate') : t('guideAuth');
  flowNode.textContent = flowHintText(card);

  syncFieldValidity(card, dirty);

  switchButton.classList.toggle('primary', canSwitch);
  switchButton.classList.toggle('ghost', !canSwitch);
  authButton.classList.toggle('secondary', canAuth);
  authButton.classList.toggle('ghost', !canAuth);
}

function ensureSelectedAccountId(accounts) {
  const ids = new Set(accounts.map((account) => account.id));
  if (state.selectedAccountId && ids.has(state.selectedAccountId)) return state.selectedAccountId;
  const active = accounts.find((account) => account.is_active);
  state.selectedAccountId = active ? active.id : (accounts[0] ? accounts[0].id : null);
  return state.selectedAccountId;
}

function renderAccountIndex(accounts) {
  const host = document.getElementById('accountIndexList');
  if (!accounts.length) {
    host.innerHTML = `
      <div class="empty-card">
        <strong>${t('emptyNoAccountsTitle')}</strong>
        <p class="muted">${t('emptyNoAccountsHint')}</p>
      </div>
    `;
    return;
  }

  const selectedId = ensureSelectedAccountId(accounts);
  host.innerHTML = sortAccounts(accounts).map((account) => `
    <button type="button" class="account-index-item ${account.id === selectedId ? 'selected' : ''}" data-account-id="${account.id}">
      <div class="account-index-item__top">
        <strong>${displayAccountName(account)}</strong>
        <span class="status-pill ${stateTone(account.display_state)}">${stateLabel(account)}</span>
      </div>
      <div class="account-index-item__signals">
        ${buildQuotaSignal(t('quotaWindow5hShort'), account.quota_5h_pct)}
        ${buildQuotaSignal(t('quotaWindow1wShort'), account.quota_week_pct)}
      </div>
      <div class="account-index-item__meta">
        <span>${account.login_method === 'google' ? t('googleLogin') : t('emailLogin')}</span>
        <span class="status-pill ${subscriptionTone(account.subscription_status)}">${buildSubscriptionLabel(account)}</span>
      </div>
    </button>
  `).join('');

  host.querySelectorAll('.account-index-item').forEach((button) => {
    button.onclick = () => {
      state.selectedAccountId = button.dataset.accountId || null;
      renderAccounts(state.runtime ? state.runtime.slots || [] : []);
    };
  });
}

function renderAccountDetail(account) {
  const host = document.getElementById('accountDetailHost');
  const template = document.getElementById('accountCardTemplate');
  host.innerHTML = '';

  if (!account) {
    host.innerHTML = `
      <div class="empty-card">
        <strong>${t('emptySelectAccountTitle')}</strong>
        <p class="muted">${t('emptySelectAccountHint')}</p>
      </div>
    `;
    return;
  }

  const fragment = template.content.cloneNode(true);
  const root = fragment.querySelector('.account-card');

  root.dataset.accountId = account.id;
  root.dataset.hasProfile = account.has_profile ? '1' : '0';
  root.dataset.hasPendingBootstrap = account.has_pending_bootstrap ? '1' : '0';
  root.dataset.isActive = account.is_active ? '1' : '0';
  root.dataset.savedLabel = account.email || '';
  root.dataset.savedEmail = account.email || '';
  root.dataset.savedLoginMethod = account.login_method || 'email';
  root.dataset.savedExpiresAt = account.expires_at || '';
  root.dataset.state = account.display_state || '';

  fragment.querySelector('.account-title').textContent = displayAccountName(account);
  fragment.querySelector('.account-subtitle').textContent = `${account.login_method === 'google' ? t('googleLogin') : t('emailLogin')} · ${freshnessLabel(account.freshness)}`;
  fragment.querySelector('.account-badge').textContent = stateLabel(account);
  fragment.querySelector('.account-badge').classList.add(stateTone(account.display_state));
  fragment.querySelector('.account-subscription').textContent = buildSubscriptionLabel(account);
  fragment.querySelector('.account-subscription').classList.add(subscriptionTone(account.subscription_status));
  fragment.querySelector('.account-stage-strip').innerHTML = buildStageStrip(account);
  fragment.querySelector('.subscription-dot').classList.add(subscriptionTone(account.subscription_status));
  fragment.querySelector('.detail-email-title').textContent = displayAccountName(account);
  fragment.querySelector('.detail-state-text').textContent = stateLabel(account);
  fragment.querySelector('.detail-summary-email-label').textContent = t('displayEmailLabel');
  fragment.querySelector('.detail-summary-state-label').textContent = t('currentStateLabel');
  fragment.querySelector('.field-label-email').textContent = t('emailLabel');
  fragment.querySelector('.field-label-login-method').textContent = t('loginMethodFieldLabel');
  fragment.querySelector('.field-label-expires-at').textContent = t('subscriptionExpiryFieldLabel');
  fragment.querySelector('.save-account').textContent = t('saveAction');
  fragment.querySelector('.switch-account').textContent = t('switchAction');
  fragment.querySelector('.logout-account').textContent = currentUiLanguage() === 'en' ? 'Log Out' : '退出';
  fragment.querySelector('.delete-account').textContent = t('deleteAction');
  const emailField = fragment.querySelector('[data-field="email"]');
  emailField.value = account.email || '';
  emailField.type = isAccountPrivacyEnabled() ? 'password' : 'email';
  emailField.placeholder = isAccountPrivacyEnabled() ? t('accountPrivacyPlaceholder') : '';
  fragment.querySelector('[data-field="login_method"]').value = account.login_method || 'email';
  fragment.querySelector('[data-field="login_method"] option[value="email"]').textContent = currentUiLanguage() === 'en' ? 'Email' : t('emailLabel');
  fragment.querySelector('[data-field="expires_at"]').value = account.expires_at || '';
  fragment.querySelector('.account-auth-progress').innerHTML = buildInlineAuthProgress(account);
  fragment.querySelector('.quota-panel').innerHTML = buildQuotaPanel(account);
  fragment.querySelector('.meta-grid').innerHTML = buildMetaGrid(account);

  host.appendChild(fragment);
  updateAccountCardState(host.querySelector('.account-card'));
}

function renderAccounts(accounts) {
  renderAccountIndex(accounts);
  if (!accounts.length) {
    renderAccountDetail(null);
    return;
  }
  const selectedId = ensureSelectedAccountId(accounts);
  const selectedAccount = accounts.find((account) => account.id === selectedId) || sortAccounts(accounts)[0];
  renderAccountDetail(selectedAccount || null);
  bindDynamicHandlers();
}

function renderSwitchLogs(items) {
  const node = document.getElementById('switchLogList');
  if (!items.length) {
    state.switchLogPage = 1;
    updateLogPager('switch', 0, 1, 1);
    node.innerHTML = `<div class="empty-card"><strong>${t('emptySwitchLogsTitle')}</strong><p class="muted">${t('emptySwitchLogsHint')}</p></div>`;
    return;
  }
  const paged = paginateLogs(items, state.switchLogPage);
  state.switchLogPage = paged.currentPage;
  updateLogPager('switch', items.length, paged.currentPage, paged.totalPages);
  node.innerHTML = paged.items.map((item) => `
    <article class="log-item">
      <div class="log-item__top">
        <div class="log-item__headline">
          <strong>${switchReasonLabel(item.trigger_reason)}</strong>
          <span class="muted">${formatTimestamp(item.created_at)}</span>
        </div>
        <span class="status-pill ${switchStatusTone(item.status)}">${switchStatusLabel(item.status)}</span>
      </div>
      <div class="log-item__summary">${t('switchFromTo', {
        from: `<strong>${escapeHtml(slotLabelById(item.from_slot_id))}</strong>`,
        to: `<strong>${escapeHtml(slotLabelById(item.to_slot_id))}</strong>`
      })}</div>
      <div class="log-item__chips">
        <span class="log-chip">${escapeHtml(slotMetaById(item.from_slot_id) || t('sourceUnknown'))}</span>
        <span class="log-chip">${escapeHtml(slotMetaById(item.to_slot_id) || t('targetUnknown'))}</span>
      </div>
      ${item.detail && item.detail.error ? `<div class="log-item__note">${escapeHtml(maskEmailsInText(item.detail.error))}</div>` : ''}
    </article>
  `).join('');
}

function renderSampleLogs(items) {
  const node = document.getElementById('sampleLogList');
  if (!items.length) {
    state.sampleLogPage = 1;
    updateLogPager('sample', 0, 1, 1);
    node.innerHTML = `<div class="empty-card"><strong>${t('emptySampleLogsTitle')}</strong><p class="muted">${t('emptySampleLogsHint')}</p></div>`;
    return;
  }
  const paged = paginateLogs(items, state.sampleLogPage);
  state.sampleLogPage = paged.currentPage;
  updateLogPager('sample', items.length, paged.currentPage, paged.totalPages);
  node.innerHTML = paged.items.map((item) => `
    <article class="log-item">
      <div class="log-item__top">
        <div class="log-item__headline">
          <strong>${escapeHtml(slotLabelById(item.slot_id))}</strong>
          <span class="muted">${formatTimestamp(item.observed_at || item.created_at)}</span>
        </div>
        <span class="status-pill ${quotaSyncStatusTone(item.parser_status)}">${quotaSyncStatusLabel(item.parser_status)}</span>
      </div>
      <div class="log-item__summary">
        ${item.parser_status === 'ok'
          ? escapeHtmlMultiline(`${quotaLineDescription(t('quotaWindow5h'), item.quota_5h_pct, item.quota_5h_reset_label, item.quota_5h_reset_at)}\n${quotaLineDescription(t('quotaWindow1w'), item.quota_week_pct, item.quota_week_reset_label, item.quota_week_reset_at)}`)
          : escapeHtmlMultiline(humanizeBackendError(item.raw_text))}
      </div>
      <div class="log-item__chips">
        <span class="log-chip">${escapeHtml(parseJsonSafe(item.raw_text)?.plan_type || t('planUnknown'))}</span>
        <span class="log-chip">${escapeHtml(item.slot_id || t('untrackedAccount'))}</span>
      </div>
    </article>
  `).join('');
}

function renderAccountsSummary(runtime) {
  const summary = runtime.summary || {};
  document.getElementById('accountsSummaryText').textContent = t('accountsSummary', {
    authenticated: summary.authenticatedAccounts || 0,
    total: summary.totalAccounts || 0,
    expiring: summary.expiringSoon || 0,
    expired: summary.expiredAccounts || 0
  });
}

async function loadRuntime(options = {}) {
  if (state.loadingRuntime) {
    state.queuedRuntimeReload = true;
    state.queuedRuntimeReloadOptions = mergeLoadOptions(state.queuedRuntimeReloadOptions, options);
    return;
  }

  state.loadingRuntime = true;
  try {
    const query = new URLSearchParams();
    if (options.fast === true) query.set('fast', '1');
    if (options.includeLogs === false) query.set('includeLogs', '0');
    const path = query.size ? `/api/runtime?${query.toString()}` : '/api/runtime';
    const json = await api(path, { method: 'GET' });
    state.runtime = json.runtime;
    state.serverTimeZone = json.runtime && json.runtime.serverTimeZone ? json.runtime.serverTimeZone : 'UTC';
    if (Array.isArray(json.recentSwitches)) state.recentSwitches = json.recentSwitches;
    if (Array.isArray(json.recentSamples)) state.recentSamples = json.recentSamples;

    syncClientPendingBootstrapFlags();
    renderRuntimeState({ includeLogs: options.includeLogs !== false });
  } finally {
    state.loadingRuntime = false;
    if (state.queuedRuntimeReload) {
      state.queuedRuntimeReload = false;
      const nextOptions = state.queuedRuntimeReloadOptions || {};
      state.queuedRuntimeReloadOptions = null;
      loadRuntime(nextOptions).catch(console.error);
    }
  }
}

function bindDynamicHandlers() {
  document.querySelectorAll('.account-card [data-field]').forEach((field) => {
    const eventName = field.tagName === 'SELECT' ? 'change' : 'input';
    field[`on${eventName}`] = () => updateAccountCardState(field.closest('.account-card'));
  });

  document.querySelectorAll('.save-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const payload = readCardFieldSnapshot(card);
      await runButtonAction(button, {
        pendingText: currentUiLanguage() === 'en' ? 'Saving...' : '保存中...',
        successText: t('accountSaved')
      }, async () => {
        await api(`/api/accounts/${accountId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        scheduleRuntimeReload(10, { fast: true, includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.bootstrap-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const restart = card.dataset.hasProfile === '1';
      await runButtonAction(button, {
        pendingText: restart ? (currentUiLanguage() === 'en' ? 'Refreshing auth...' : '重置认证中...') : (currentUiLanguage() === 'en' ? 'Creating task...' : '创建任务中...'),
        successText: restart ? t('restartedBootstrap') : t('createdBootstrap'),
        refreshOnError: true
      }, async () => {
        const result = await startBootstrapTask(accountId, { restart });
        optimisticBootstrapStart(result);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.switch-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      await runButtonAction(button, {
        pendingText: currentUiLanguage() === 'en' ? 'Switching...' : '切换中...',
        successText: t('switchedToAccount', { name: displayAccountName(readCardFieldSnapshot(card)) })
      }, async () => {
        await api(`/api/accounts/${accountId}/switch`, {
          method: 'POST',
          body: '{}'
        });
        scheduleRuntimeReload(10, { fast: true, includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.logout-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      await runButtonAction(button, {
        pendingText: currentUiLanguage() === 'en' ? 'Logging out...' : '退出中...',
        successText: t('logoutServerRetained')
      }, async () => {
        await api(`/api/accounts/${accountId}/logout`, {
          method: 'POST',
          body: '{}'
        });
        scheduleRuntimeReload(10, { fast: true, includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.delete-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const label = card.querySelector('.account-title').textContent.trim();
      if (!window.confirm(t('deleteAccountConfirm', { label }))) return;
      await runButtonAction(button, {
        pendingText: currentUiLanguage() === 'en' ? 'Deleting...' : '删除中...',
        successText: t('accountDeleted')
      }, async () => {
        await api(`/api/accounts/${accountId}`, {
          method: 'DELETE',
          body: '{}'
        });
        if (state.selectedAccountId === accountId) state.selectedAccountId = null;
        scheduleRuntimeReload(10, { fast: true, includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.inline-copy-device-code').forEach((button) => {
    button.onclick = async () => {
      const code = button.dataset.deviceCode || '';
      if (!code || code === '--') return;
      try {
        await navigator.clipboard.writeText(code);
        showToast(t('copiedDeviceCode', { code }), 'success');
      } catch (_) {
        showToast(`${t('deviceCodeLabel')}: ${code}`, 'warning');
      }
    };
  });

  document.querySelectorAll('.inline-copy-target-email').forEach((button) => {
    button.onclick = async () => {
      const email = button.dataset.targetEmail || '';
      if (!email) return;
      try {
        await navigator.clipboard.writeText(email);
        showToast(t('copiedTargetAccount', { email }), 'success');
      } catch (_) {
        showToast(`${t('targetAccountLabel')}: ${email}`, 'warning');
      }
    };
  });

  document.querySelectorAll('.inline-copy-auth-link').forEach((button) => {
    button.onclick = async () => {
      const url = button.dataset.authOpenUrl || '';
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        showToast(t('copiedAuthLink'), 'success');
      } catch (_) {
        showToast(url, 'warning');
      }
    };
  });

  document.querySelectorAll('.inline-open-auth-link').forEach((button) => {
    button.onclick = async () => {
      const url = button.dataset.authOpenUrl || '';
      if (!url) return;
      window.open(url, '_blank', 'noopener');
      showToast(t('openedAuthLink'), 'success');
    };
  });

  document.querySelectorAll('.inline-restart-bootstrap').forEach((button) => {
    button.onclick = async () => {
      const slotId = button.dataset.slotId || '';
      if (!slotId) return;
      await runButtonAction(button, {
        pendingText: currentUiLanguage() === 'en' ? 'Resetting...' : '重置中...',
        successText: t('restartedBootstrap')
      }, async () => {
        const result = await startBootstrapTask(slotId, { restart: true });
        optimisticBootstrapStart(result);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.inline-delete-bootstrap-task').forEach((button) => {
    button.onclick = async () => {
      const bootstrapId = button.dataset.bootstrapId || '';
      if (!bootstrapId) return;
      await runButtonAction(button, {
        pendingText: currentUiLanguage() === 'en' ? 'Clearing...' : '清除中...',
        successText: t('bootstrapDeleted'),
        refreshOnError: true
      }, async () => {
        optimisticBootstrapDelete(bootstrapId);
        await api(`/api/bootstrap-sessions/${bootstrapId}`, {
          method: 'DELETE',
          body: '{}'
        });
        state.openBootstrapLogIds.delete(bootstrapId);
        scheduleRuntimeReload(10, { fast: true, includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.task-details').forEach((details) => {
    details.ontoggle = () => {
      const bootstrapId = details.dataset.bootstrapId;
      if (!bootstrapId) return;
      if (details.open) state.openBootstrapLogIds.add(bootstrapId);
      else state.openBootstrapLogIds.delete(bootstrapId);
    };
  });
}

function startRuntimeRefreshLoop() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    scheduleRuntimeReload(0);
  }, REFRESH_INTERVAL_MS);
}

function startEventStream() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource('/api/events/stream', { withCredentials: true });
  source.addEventListener('runtime_updated', () => {
    scheduleRuntimeReload(40);
  });
  source.onerror = () => {};
  state.eventSource = source;
}

async function initDashboard(session) {
  document.body.classList.remove('is-login-mode');
  document.getElementById('loginPanel').classList.add('hidden');
  document.getElementById('dashboardPanel').classList.remove('hidden');
  document.getElementById('createAccountBtn').classList.remove('hidden');
  document.getElementById('logoutBtn').classList.remove('hidden');
  document.getElementById('timeDisplayToggleBtn').classList.remove('hidden');
  document.getElementById('accountPrivacyToggleBtn').classList.remove('hidden');
  renderWorkspaceGuide();
  setSessionBadge(session.user.email);
  renderRuntimeTimestamp(new Date().toISOString());
  loadRuntime({ fast: true, includeLogs: false })
    .catch(console.error)
    .finally(() => {
      window.setTimeout(() => {
        loadRuntime().catch(console.error);
      }, 80);
    });
  startRuntimeRefreshLoop();
  startEventStream();
}

async function initApp() {
  try {
    const storedLanguage = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    if (storedLanguage === 'en' || storedLanguage === 'zh-CN') state.uiLanguage = storedLanguage;
  } catch (_) {
    state.uiLanguage = 'zh-CN';
  }
  try {
    const stored = window.localStorage.getItem(TIME_DISPLAY_STORAGE_KEY);
    if (stored === 'local' || stored === 'server') state.timeDisplayMode = stored;
  } catch (_) {
    state.timeDisplayMode = 'server';
  }
  try {
    state.accountPrivacyEnabled = window.localStorage.getItem(ACCOUNT_PRIVACY_STORAGE_KEY) === '1';
  } catch (_) {
    state.accountPrivacyEnabled = false;
  }
  try {
    const publicConfig = await fetch('/api/public-config', { credentials: 'include' }).then((res) => res.json());
    if (publicConfig && publicConfig.ok) {
      state.publicConfig = {
        defaultUiLanguage: publicConfig.defaultUiLanguage || 'zh-CN',
        codeWorkspaceUrl: publicConfig.codeWorkspaceUrl || '',
        codeOrigin: publicConfig.codeOrigin || ''
      };
      if (!(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) === 'en' || window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) === 'zh-CN')) {
        state.uiLanguage = state.publicConfig.defaultUiLanguage === 'en' ? 'en' : 'zh-CN';
      }
    }
  } catch (_) {
    // ignore public config failures and keep defaults
  }
  applyStaticTranslations();
  syncTimeDisplayButton();
  syncAccountPrivacyButton();
  const sessionPromise = fetch('/api/session', { credentials: 'include' }).then((res) => res.json());
  refreshCsrf().catch(() => {});
  const session = await sessionPromise;
  if (!session.authenticated) {
    document.body.classList.add('is-login-mode');
    document.getElementById('loginPanel').classList.remove('hidden');
    document.getElementById('dashboardPanel').classList.add('hidden');
    document.getElementById('createAccountBtn').classList.add('hidden');
    document.getElementById('logoutBtn').classList.add('hidden');
    document.getElementById('timeDisplayToggleBtn').classList.add('hidden');
    document.getElementById('accountPrivacyToggleBtn').classList.add('hidden');
    setSessionBadge(t('sessionLoggedOut'));
    return;
  }

  await initDashboard(session);
}

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await refreshCsrf();
  const submitButton = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  await runButtonAction(submitButton, {
    pendingText: t('loggingIn'),
    successText: t('loginSuccess')
  }, async () => {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value
      })
    });
    const session = await fetch('/api/session', { credentials: 'include' }).then((res) => res.json());
    await initDashboard(session);
  }).catch(() => {});
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  const button = document.getElementById('logoutBtn');
  await runButtonAction(button, {
    pendingText: t('loggingOut'),
    successText: t('logoutSuccess')
  }, async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    window.location.reload();
  }).catch(() => {});
});

document.getElementById('createAccountBtn').addEventListener('click', async () => {
  const button = document.getElementById('createAccountBtn');
  await runButtonAction(button, {
    pendingText: currentUiLanguage() === 'en' ? 'Creating...' : '新建中...',
    successText: t('copiedCreateHint')
  }, async () => {
    const result = await api('/api/accounts', {
      method: 'POST',
      body: '{}'
    });
    state.selectedAccountId = result.account.id;
    scheduleRuntimeReload(10);
  }).catch(() => {});
});

document.getElementById('timeDisplayToggleBtn').addEventListener('click', () => {
  state.timeDisplayMode = currentTimeMode() === 'local' ? 'server' : 'local';
  try {
    window.localStorage.setItem(TIME_DISPLAY_STORAGE_KEY, state.timeDisplayMode);
  } catch (_) {
    // ignore localStorage failures
  }
  syncTimeDisplayButton();
  if (state.runtime) {
    renderRuntimeTimestamp(state.runtime.now);
    renderActiveSlot(state.runtime);
    renderAccounts(state.runtime.slots || []);
    renderSwitchLogs(state.recentSwitches || []);
    renderSampleLogs(state.recentSamples || []);
  }
});

document.getElementById('accountPrivacyToggleBtn').addEventListener('click', () => {
  state.accountPrivacyEnabled = !isAccountPrivacyEnabled();
  try {
    window.localStorage.setItem(ACCOUNT_PRIVACY_STORAGE_KEY, state.accountPrivacyEnabled ? '1' : '0');
  } catch (_) {
    // ignore localStorage failures
  }
  syncAccountPrivacyButton();
  if (state.runtime) renderRuntimeState();
  setSessionBadge(state.sessionEmail || t('sessionLoggedOut'));
});

document.getElementById('languageToggleBtn').addEventListener('click', () => {
  state.uiLanguage = currentUiLanguage() === 'en' ? 'zh-CN' : 'en';
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, state.uiLanguage);
  } catch (_) {
    // ignore localStorage failures
  }
  applyStaticTranslations();
  if (state.runtime) {
    renderRuntimeTimestamp(state.runtime.now || new Date().toISOString());
    renderRuntimeState();
  }
  setSessionBadge(state.sessionEmail || t('sessionLoggedOut'));
});

const clearBootstrapTasksBtn = document.getElementById('clearBootstrapTasksBtn');
if (clearBootstrapTasksBtn) {
  clearBootstrapTasksBtn.addEventListener('click', async () => {
    const button = clearBootstrapTasksBtn;
    const sessions = state.runtime && Array.isArray(state.runtime.bootstrapSessions) ? state.runtime.bootstrapSessions : [];
    if (!sessions.length) return;
    if (!window.confirm(t('clearAllBootstrapConfirm', { count: sessions.length }))) return;
    await runButtonAction(button, {
      pendingText: currentUiLanguage() === 'en' ? 'Clearing...' : '清除中...',
      successText: t('clearedBootstrapTasks', { count: sessions.length })
    }, async () => {
      await api('/api/bootstrap-sessions', {
        method: 'DELETE',
        body: '{}'
      });
      state.openBootstrapLogIds.clear();
      scheduleRuntimeReload(10, { fast: true, includeLogs: false });
      scheduleRuntimeReload(220);
    }).catch(() => {});
  });
}

document.getElementById('switchLogPrevBtn').addEventListener('click', () => {
  state.switchLogPage = Math.max(1, state.switchLogPage - 1);
  renderSwitchLogs(state.recentSwitches || []);
});

document.getElementById('switchLogNextBtn').addEventListener('click', () => {
  state.switchLogPage += 1;
  renderSwitchLogs(state.recentSwitches || []);
});

document.getElementById('switchLogPageInfo').addEventListener('click', () => {
  setLogPageEditMode('switch', true);
});

document.getElementById('switchLogPageInfo').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    setLogPageEditMode('switch', true);
  }
});

document.getElementById('switchLogJumpInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    jumpToLogPage('switch');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    setLogPageEditMode('switch', false);
  }
});

document.getElementById('switchLogJumpInput').addEventListener('blur', () => {
  jumpToLogPage('switch');
});

document.getElementById('sampleLogPrevBtn').addEventListener('click', () => {
  state.sampleLogPage = Math.max(1, state.sampleLogPage - 1);
  renderSampleLogs(state.recentSamples || []);
});

document.getElementById('sampleLogNextBtn').addEventListener('click', () => {
  state.sampleLogPage += 1;
  renderSampleLogs(state.recentSamples || []);
});

document.getElementById('sampleLogPageInfo').addEventListener('click', () => {
  setLogPageEditMode('sample', true);
});

document.getElementById('sampleLogPageInfo').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    setLogPageEditMode('sample', true);
  }
});

document.getElementById('sampleLogJumpInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    jumpToLogPage('sample');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    setLogPageEditMode('sample', false);
  }
});

document.getElementById('sampleLogJumpInput').addEventListener('blur', () => {
  jumpToLogPage('sample');
});

document.getElementById('clearSwitchLogsBtn').addEventListener('click', async () => {
  const button = document.getElementById('clearSwitchLogsBtn');
  const count = (state.recentSwitches || []).length;
  if (!count) return;
  if (!window.confirm(t('clearSwitchLogsConfirm', { count }))) return;
  await runButtonAction(button, {
    pendingText: currentUiLanguage() === 'en' ? 'Clearing...' : '清空中...',
    successText: t('clearSwitchLogsSuccess', { count })
  }, async () => {
    state.switchLogPage = 1;
    await api('/api/logs/switches', {
      method: 'DELETE',
      body: '{}'
    });
    scheduleRuntimeReload(10);
  }).catch(() => {});
});

document.getElementById('clearSampleLogsBtn').addEventListener('click', async () => {
  const button = document.getElementById('clearSampleLogsBtn');
  const count = (state.recentSamples || []).length;
  if (!count) return;
  if (!window.confirm(t('clearSampleLogsConfirm', { count }))) return;
  await runButtonAction(button, {
    pendingText: currentUiLanguage() === 'en' ? 'Clearing...' : '清空中...',
    successText: t('clearSampleLogsSuccess', { count })
  }, async () => {
    state.sampleLogPage = 1;
    await api('/api/logs/quota-samples', {
      method: 'DELETE',
      body: '{}'
    });
    scheduleRuntimeReload(10);
  }).catch(() => {});
});

initApp().catch(console.error);
