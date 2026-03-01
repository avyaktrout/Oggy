// Diet Agent - Chat Page
const shell = new AgentShell({
    domain: 'diet',
    label: 'Diet Agent',
    chatEndpoint: '/v0/diet/chat',
    trainingEndpoint: '/v0/continuous-learning',
    analyticsPage: '/diet-analytics.html',
    observerBasePath: '/v0/diet/observer',
    chatPlaceholder: 'Tell me what you ate, or ask about nutrition...',
    welcomeMessage: "Hi! I'm Oggy, your diet and nutrition assistant. Tell me what you ate, ask about nutrition, or get personalized diet advice!",
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
