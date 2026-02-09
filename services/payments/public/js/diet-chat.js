// Diet Agent - Chat Page
const shell = new AgentShell({
    domain: 'diet',
    label: 'Diet Agent',
    chatEndpoint: '/v0/diet/chat',
    trainingEndpoint: '/v0/continuous-learning',
    chatPlaceholder: 'Tell me what you ate, or ask about nutrition...',
    welcomeMessage: "Hi! I'm Oggy, your diet and nutrition assistant. Tell me what you ate, ask about nutrition, or get personalized diet advice!",
    contextProvider: async () => ({}),
    capabilities: {
        training: false,
        comparison: false,
        inquiries: false,
        observer: false,
        audit: false
    }
});

shell.init();