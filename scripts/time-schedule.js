/**
 * Custom Web Component for Weekly Time Selection
 * Usage: <time-schedule></time-schedule>
 */
class TimeSchedule extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    }

    connectedCallback() {
        this.render();
    }

    render() {
        const style = `
      <style>
        :host { 
          font-family: inherit; 
          display: block; 
          background: transparent;
        }
        .day-row { 
          display: flex; 
          align-items: center; 
          justify-content: space-between;
          padding: 8px 0; 
          border-bottom: 1px solid rgba(0,0,0,0.05);
          color: inherit;
        }
        :host-context(.dark) .day-row {
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .day-row:last-child { border-bottom: none; }
        .day-row.closed { opacity: 0.6; }
        
        .label-group { 
          display: flex; 
          align-items: center; 
          gap: 12px; 
          width: 130px;
        }
        
        .time-group { 
          display: flex; 
          align-items: center; 
          gap: 8px; 
        }

        input[type="checkbox"] { 
          width: 16px; 
          height: 16px; 
          cursor: pointer;
          accent-color: #16a34a;
        }
        input[type="time"] { 
          padding: 4px; 
          border: 1px solid #ddd; 
          border-radius: 4px; 
          font-size: 0.85rem;
          background: #fff;
          color: #000;
        }
        :host-context(.dark) input[type="time"] {
          background: #0f172a;
          color: #fff;
          border-color: #334155;
        }
        input:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .status-label { 
          font-size: 0.75rem; 
          font-weight: bold; 
          color: #ef4444; 
          width: 50px; 
          text-align: right; 
        }
        .status-label.open { color: #16a34a; }
      </style>
    `;

        const rows = this.days.map(day => `
      <div class="day-row" id="row-${day}">
        <div class="label-group">
          <input type="checkbox" checked id="check-${day}">
          <label><strong>${day}</strong></label>
        </div>
        <div class="time-group" id="group-${day}">
          <input type="time" value="08:00" id="start-${day}">
          <span>to</span>
          <input type="time" value="17:00" id="end-${day}">
        </div>
        <div class="status-label open" id="status-${day}">OPEN</div>
      </div>
    `).join('');

        this.shadowRoot.innerHTML = style + rows;
        this.setupEvents();
    }

    setupEvents() {
        this.days.forEach(day => {
            const checkbox = this.shadowRoot.getElementById(`check-${day}`);
            const row = this.shadowRoot.getElementById(`row-${day}`);
            const start = this.shadowRoot.getElementById(`start-${day}`);
            const end = this.shadowRoot.getElementById(`end-${day}`);
            const status = this.shadowRoot.getElementById(`status-${day}`);
            const timeGroup = this.shadowRoot.getElementById(`group-${day}`);

            checkbox.addEventListener('change', () => {
                const isOpen = checkbox.checked;
                start.disabled = !isOpen;
                end.disabled = !isOpen;
                row.classList.toggle('closed', !isOpen);
                timeGroup.classList.toggle('hidden', !isOpen);
                status.textContent = isOpen ? 'OPEN' : 'CLOSED';
                status.classList.toggle('open', isOpen);
                this.dispatchEvent(new CustomEvent('change', { bubbles: true }));
            });

            start.addEventListener('input', () => {
                this.dispatchEvent(new CustomEvent('change', { bubbles: true }));
            });

            end.addEventListener('input', () => {
                this.dispatchEvent(new CustomEvent('change', { bubbles: true }));
            });
        });
    }

    // Use this method to get the data for your database/API
    getScheduleData() {
        return this.days.map(day => {
            const isOpen = this.shadowRoot.getElementById(`check-${day}`).checked;
            return {
                day: day,
                status: isOpen ? 'open' : 'closed',
                openingTime: this.shadowRoot.getElementById(`start-${day}`).value,
                closingTime: this.shadowRoot.getElementById(`end-${day}`).value
            };
        });
    }

    // Set data programmatically
    setScheduleData(data) {
        if (!Array.isArray(data)) return;
        data.forEach(item => {
            const day = item.day;
            const checkbox = this.shadowRoot.getElementById(`check-${day}`);
            const start = this.shadowRoot.getElementById(`start-${day}`);
            const end = this.shadowRoot.getElementById(`end-${day}`);
            const row = this.shadowRoot.getElementById(`row-${day}`);
            const status = this.shadowRoot.getElementById(`status-${day}`);
            const timeGroup = this.shadowRoot.getElementById(`group-${day}`);

            if (checkbox && start && end) {
                const isOpen = item.status === 'open';
                checkbox.checked = isOpen;
                start.value = item.openingTime || '08:00';
                end.value = item.closingTime || '17:00';
                
                // Update UI state
                start.disabled = !isOpen;
                end.disabled = !isOpen;
                row.classList.toggle('closed', !isOpen);
                timeGroup.classList.toggle('hidden', !isOpen);
                status.textContent = isOpen ? 'OPEN' : 'CLOSED';
                status.classList.toggle('open', isOpen);
            }
        });
        this.dispatchEvent(new CustomEvent('change', { bubbles: true }));
    }
}

customElements.define('time-schedule', TimeSchedule);