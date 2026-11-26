// Draw the hero's slowly changing blue and silver cloud field.
(() => {
  const canvas = document.querySelector(".light canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false, antialias: false, depth: false, powerPreference: "low-power",
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) return;

  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const frameInterval = 1000 / 30;
  let visible = false;
  let frame = 0;
  let lastPaint = null;
  let elapsed = 0;
  let program;
  let size;
  let time;

  function initialize() {
    // A single triangle covers the viewport without a vertex buffer.
    const vertex = `#version 300 es
      void main() {
        vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
      }`;
    const fragment = `#version 300 es
      precision highp float;
      uniform vec2 size;
      uniform float seconds;
      out vec4 pixel;

      float hash(vec3 cell) {
        vec3 h = fract(cell * vec3(.1031, .1030, .0973));
        h += dot(h, h.yxz + 33.33);
        return fract((h.x + h.y) * h.z);
      }

      float noise(vec3 p) {
        vec3 cell = floor(p), f = fract(p);
        f = f*f*(3.0-2.0*f);
        vec4 corners = vec4(0, 1, 0, 1);
        vec4 rows;
        for (int i = 0; i < 4; i++) {
          vec3 root = cell + vec3(0, corners[i], float(i / 2));
          rows[i] = mix(hash(root), hash(root + vec3(1,0,0)), f.x);
        }
        return mix(mix(rows.x, rows.y, f.y), mix(rows.z, rows.w, f.y), f.z);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / size;
        vec2 p = vec2((uv.x - .5)*size.x/size.y, uv.y-.5);
        float t = seconds * .025;
        vec2 bend = vec2(noise(vec3(p*2.7 + 6.1, t)),
                         noise(vec3(p*2.4 - 2.7, -t*.83))) - .5;
        vec2 flow = p + bend*.55;
        float cloud = noise(vec3(flow*3.1 + 1.9, .73 + t*.71));
        float fold = noise(vec3(flow*4.3 + cloud*.8 + 7.0, 2.8 - t*.62));
        float sky = smoothstep(.27,.98, uv.y*.80 + uv.x*.29 + bend.y*.20);
        float blue = smoothstep(.10,.93, .52*cloud + .16*fold + .43*sky);
        vec3 color = mix(vec3(.017,.027,.046), vec3(.14,.30,.49), blue);

        // Stretch the broad field across the sky; smaller eddies bend its soft margins.
        vec2 current = (p + .32*bend)*vec2(.58,.84) + vec2(.026, -.006)*seconds;
        float swell = noise(vec3(current*2.6 + vec2(4.5,1.8), .9 + .048*seconds));
        vec2 eddy = mat2(.8,.6,-.6,.8)*current + vec2(fold,-swell)*.30;
        float ripple = noise(vec3(eddy*5.5 + vec2(2.7,5.6), 1.2 - .065*seconds));
        float density = .78*swell + .22*ripple;
        float upperCloud = smoothstep(.42, .96, uv.y + .11*bend.y + .07*(fold-.5));
        float crest = upperCloud*smoothstep(.18, .82, density);
        color = mix(color, vec3(.61,.62,.62), crest*.62);
        color += .038*(fold-.5);
        vec2 toLight = (uv - vec2(.89,.47))*vec2(size.x/size.y,1);
        color += vec3(.11,.106,.10)*exp(-4.8*dot(toLight,toLight));
        color *= 1.0 - .38*smoothstep(.28,.83,length(p));
        color += (hash(vec3(floor(gl_FragCoord.xy/2.0), 3.0))-.5)*.009;
        pixel = vec4(color,1);
      }`;
    program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Theta hero shader:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      program = null;
      return;
    }
    gl.useProgram(program);
    size = gl.getUniformLocation(program, "size");
    time = gl.getUniformLocation(program, "seconds");
    resize();
  }

  function draw() {
    gl.uniform1f(time, elapsed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.style.opacity = "1";
  }

  function tick(now) {
    frame = requestAnimationFrame(tick);
    const delta = lastPaint === null ? 0 : now - lastPaint;
    if (lastPaint !== null && delta + .1 < frameInterval) return;
    elapsed += Math.min(delta, 100) / 1000;
    lastPaint = now;
    draw();
  }

  function sync() {
    cancelAnimationFrame(frame);
    lastPaint = null;
    if (!program || !visible || document.hidden) return;
    if (motion.matches) draw();
    else frame = requestAnimationFrame(tick);
  }

  function resize() {
    if (!program) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = Math.min(devicePixelRatio, 1.5, Math.sqrt(1000000 / (width * height)));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(size, canvas.width, canvas.height);
    sync();
  }

  canvas.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    program = null;
    canvas.style.opacity = "0";
    sync();
  });
  canvas.addEventListener("webglcontextrestored", initialize);
  initialize();
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener("visibilitychange", sync);
  motion.addEventListener("change", sync);
})();
