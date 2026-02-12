// Payments Chat Page — uses shared AgentShell
const shell = new AgentShell({
    domain: 'payments',
    label: 'Payments Chat',
    chatEndpoint: '/v0/chat',
    trainingEndpoint: '/v0/continuous-learning',
    analyticsPage: '/analytics.html',
    chatPlaceholder: 'Ask about your spending, categorization, or anything...',
    welcomeMessage: "Hi! I'm Oggy. Ask me about your spending, or have me categorize an expense. I learn from our interactions!",
    baseWelcome: "Hi! I'm the base model without memory. Compare my answers with Oggy's to see the difference learning makes.",
    contextProvider: async () => ({}),
    capabilities: {
        training: true,
        comparison: true,
        inquiries: true,
        observer: true,
        audit: true
    }
});

shell.init();
