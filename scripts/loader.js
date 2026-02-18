
document.addEventListener('DOMContentLoaded', () => {
    const loaderId = 'global-loader';
    if (document.getElementById(loaderId)) {
        return;
    }

    const loaderHTML = `
        <div id="${loaderId}" class="fixed inset-0 bg-gray-50 dark:bg-slate-900 bg-opacity-90 dark:bg-opacity-90 flex flex-col justify-center items-center z-50">
            <div class="loader ease-linear rounded-full border-8 border-t-8 border-gray-200 dark:border-slate-700 h-24 w-24 mb-4"></div>
            <p class="text-lg opacity-70">Please wait...</p>
        </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
        .loader {
            border-top-color: #22c55e; /* green-500 */
            animation: spinner 1.5s linear infinite;
        }

        @keyframes spinner {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `;

    document.head.appendChild(style);
    document.body.insertAdjacentHTML('beforeend', loaderHTML);
});

function showLoader() {
    const loader = document.getElementById('global-loader');
    if (loader) {
        loader.style.display = 'flex';
    }
}

function hideLoader() {
    const loader = document.getElementById('global-loader');
    if (loader) {
        loader.style.display = 'none';
    }
}
