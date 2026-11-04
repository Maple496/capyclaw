/**
 * PPT 编辑器 - 侧边栏 UI 组件
 * 
 * 这个文件提供了侧边栏的 HTML/CSS/JS
 * 如果 Harness 支持 React，可以改写成 React 组件
 */

// 注意: 这是一个占位文件
// 实际的 UI 需要根据 DeepSeek Harness 的前端架构来实现
// 可能是 React 组件、Vue 组件或纯 HTML

export function createPPTEditorUI() {
  return {
    // UI 组件定义
    component: 'PPTEditorPanel',
    
    // 初始化函数
    init: (container, ctx) => {
      // 渲染 UI
      container.innerHTML = `
        <div class="ppt-editor-panel">
          <div class="ppt-header">
            <h2>📊 PPT 编辑器</h2>
            <div class="ppt-status">就绪</div>
          </div>
          
          <div class="ppt-slides">
            <div class="empty-state">
              <div class="empty-icon">🎨</div>
              <p>还没有 PPT</p>
              <p class="hint">在左侧对话框中让 AI 创建 PPT</p>
            </div>
          </div>
        </div>
      `
      
      // 监听状态变化
      ctx.on('ppt-editor:state-changed', (state) => {
        updateUI(container, state)
      })
    }
  }
}

function updateUI(container, state) {
  const slidesContainer = container.querySelector('.ppt-slides')
  
  if (state.slides.length === 0) {
    slidesContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎨</div>
        <p>还没有 PPT</p>
        <p class="hint">在左侧对话框中让 AI 创建 PPT</p>
      </div>
    `
    return
  }
  
  slidesContainer.innerHTML = state.slides.map((slide, index) => `
    <div class="slide-card ${index === state.currentSlideIndex ? 'active' : ''}">
      <div class="slide-number">幻灯片 ${index + 1}</div>
      <h3 class="slide-title">${escapeHtml(slide.title)}</h3>
      <p class="slide-content">${escapeHtml(slide.content)}</p>
      <div class="slide-meta">${slide.layout}</div>
    </div>
  `).join('')
}

function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
