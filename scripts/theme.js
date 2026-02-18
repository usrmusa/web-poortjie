// theme.js - Universal theme handler
(function() {
    const html = document.documentElement;
    const themeIcon = document.getElementById('theme-icon');
    const menuThemeIcon = document.getElementById('menu-theme-icon');

    const setIcon = (iconElement) => {
        if (!iconElement) return;
        if (html.classList.contains('dark')) {
            iconElement.textContent = '☀️';
        } else {
            iconElement.textContent = '🌓';
        }
    };

    const updateAllIcons = () => {
        setIcon(themeIcon);
        setIcon(menuThemeIcon);
    };

    // 1. Immediate application (to prevent flash of unstyled content)
    if (localStorage.getItem('theme') === 'dark') {
        html.classList.add('dark');
    } else {
        html.classList.remove('dark');
    }

    // 2. DOMContentLoaded logic
    const initTheme = () => {
        updateAllIcons();

        const themeToggle = document.getElementById('theme-toggle');
        const menuThemeToggle = document.getElementById('menu-theme-toggle');

        const toggleTheme = () => {
            const isDark = html.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateAllIcons();
            
            // Dispatch event for any other listeners
            window.dispatchEvent(new Event('themeChanged'));
        };

        if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
        if (menuThemeToggle) menuThemeToggle.addEventListener('click', toggleTheme);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTheme);
    } else {
        initTheme();
    }
})();