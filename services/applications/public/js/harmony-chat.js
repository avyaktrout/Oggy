// Harmony Agent - Chat & Training Page
const shell = new AgentShell({
    domain: 'harmony',
    label: 'Harmony Agent',
    chatEndpoint: '/v0/harmony/chat',
    trainingEndpoint: '/v0/continuous-learning',
    analyticsPage: '/harmony-analytics.html',
    chatPlaceholder: 'Ask about city metrics, suggest improvements...',
    welcomeMessage: "Hi! I'm Oggy, your Harmony Map assistant. Ask about city metrics, compare cities, suggest new data sources, or explore what drives well-being scores!",
    baseWelcome: "Hi! I'm the base model without memory. Compare my answers with Oggy's to see the difference learning makes.",
    contextProvider: async () => ({}),
    capabilities: {
        training: true,
        comparison: true,
        inquiries: false,
        observer: false,
        audit: false
    }
});

shell.init();
