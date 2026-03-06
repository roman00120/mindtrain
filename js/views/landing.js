/**
 * Landing Page View
 */
export const landingView = {
    title: 'Narrativa | Convierte tus ideas en leyendas',
    render: () => `
        <div class="landing-container" style="min-height: 100vh; overflow-x: hidden; position: relative;">
            <div class="hero-section" style="height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; background: radial-gradient(circle at center, rgba(124, 77, 255, 0.15) 0%, transparent 70%);">
                <div class="hero-content" style="max-width: 800px; padding: 2rem; animation: slideUp 0.8s cubic-bezier(0.16, 1, 0.3, 1);">
                    <div style="font-size: 1.2rem; color: var(--accent-secondary); margin-bottom: 1rem; letter-spacing: 4px; font-weight: 700; text-transform: uppercase;">Nebula</div>
                    <h1 style="font-size: clamp(2.5rem, 8vw, 5rem); line-height: 1.1; margin-bottom: 1.5rem; background: linear-gradient(135deg, #fff 0%, #a0a0c0 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Convierte tus ideas en leyendas</h1>
                    <p style="font-size: 1.2rem; color: var(--text-secondary); margin-bottom: 2.5rem; line-height: 1.6; max-width: 600px; margin-inline: auto;">La herramienta de escritura definitiva para tejedores de historias. Organiza personajes, mundos y tramas en una interfaz dise&ntilde;ada para la creatividad.</p>
                    <div style="display: flex; gap: 20px; justify-content: center; flex-wrap: wrap;">
                        <button id="cta-start" class="glass" style="padding: 1.2rem 2.5rem; font-size: 1.1rem; background: var(--accent-primary); color: white; border: none; font-weight: 700; cursor: pointer; border-radius: 50px; box-shadow: 0 10px 30px var(--accent-glow);">Empieza a escribir gratis</button>
                        <button class="glass" style="padding: 1.2rem 2.5rem; font-size: 1.1rem; color: white; border: none; font-weight: 700; cursor: pointer; border-radius: 50px;">Descubre m&aacute;s</button>
                    </div>
                </div>
            </div>

            <div class="features-section" style="padding: 6rem 2rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; max-width: 1200px; margin: 0 auto;">
                <div class="glass" style="padding: 2.5rem; transition: var(--transition);">
                    <div style="font-size: 2rem; margin-bottom: 1rem;">M1</div>
                    <h3>Arquitectura de Mundos</h3>
                    <p style="color: var(--text-secondary); margin-top: 1rem;">Crea mapas detallados de lugares y objetos con interconexiones l&oacute;gicas.</p>
                </div>
                <div class="glass" style="padding: 2.5rem; transition: var(--transition);">
                    <div style="font-size: 2rem; margin-bottom: 1rem;">M2</div>
                    <h3>Red de Personajes</h3>
                    <p style="color: var(--text-secondary); margin-top: 1rem;">Visualiza relaciones complejas y &Aacute;rboles geneal&oacute;gicos en un lienzo infinito.</p>
                </div>
                <div class="glass" style="padding: 2.5rem; transition: var(--transition);">
                    <div style="font-size: 2rem; margin-bottom: 1rem;">M3</div>
                    <h3>Cronolog&iacute;as Din&aacute;micas</h3>
                    <p style="color: var(--text-secondary); margin-top: 1rem;">Mant&eacute;n la coherencia temporal de tu narrativa con l&iacute;neas de tiempo multiversales.</p>
                </div>
            </div>
        </div>
    `
};

