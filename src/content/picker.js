export class ElementPicker {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.overlay = null;
    this.selectedElement = null;
    this.isActive = false;

    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this.createOverlay();
    document.addEventListener('mousemove', this.handleMouseMove, true);
    document.addEventListener('click', this.handleClick, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    document.body.style.cursor = 'crosshair';
  }

  stop() {
    this.isActive = false;
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    document.removeEventListener('mousemove', this.handleMouseMove, true);
    document.removeEventListener('click', this.handleClick, true);
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.body.style.cursor = '';
  }

  createOverlay() {
    if (this.overlay) return;
    this.overlay = document.createElement('div');
    this.overlay.className = 'design-clone-overlay';
    
    // Ensure it's visible even on sites with complex styles
    Object.assign(this.overlay.style, {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '2147483647',
      backgroundColor: 'rgba(0, 123, 255, 0.3)',
      border: '2px solid #007bff',
      display: 'none' // Hidden until first mouse move
    });

    this.label = document.createElement('span');
    this.label.className = 'design-clone-label';
    Object.assign(this.label.style, {
      position: 'absolute',
      backgroundColor: '#007bff',
      color: 'white',
      padding: '2px 6px',
      fontSize: '12px',
      borderRadius: '3px',
      top: '-24px',
      left: '0'
    });

    this.overlay.appendChild(this.label);
    document.body.appendChild(this.overlay);
  }

  handleMouseMove(e) {
    if (!this.isActive) return;

    const target = e.target;
    if (target === this.overlay || target === this.label || !target) return;

    this.selectedElement = target;
    this.updateOverlay(target);
  }

  updateOverlay(element) {
    if (!this.overlay) return;
    
    const rect = element.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    this.overlay.style.display = 'block';
    this.overlay.style.width = `${rect.width}px`;
    this.overlay.style.height = `${rect.height}px`;
    this.overlay.style.top = `${rect.top + scrollY}px`;
    this.overlay.style.left = `${rect.left + scrollX}px`;

    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const classes = Array.from(element.classList).map(c => `.${c}`).join('');
    this.label.textContent = `${tag}${id}${classes}`;
  }

  handleClick(e) {
    if (!this.isActive) return;
    e.preventDefault();
    e.stopPropagation();

    if (this.selectedElement) {
      this.onSelect(this.selectedElement);
    }
    this.stop();
  }

  handleKeyDown(e) {
    if (e.key === 'Escape') {
      this.stop();
    }
  }
}
