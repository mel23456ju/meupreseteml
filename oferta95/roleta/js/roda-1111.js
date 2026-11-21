/* Roleta desenhada em <canvas> (substitui a imagem XZZ4Bk9XX9cl.png). Tema de Natal desde 16/11 (antes: 11.11).
 *
 * Segue a arte "Promoção de Natal" (assets/images/questionario/descubra.jpg): fatias amarelo/vermelho alternadas,
 * logo do Mercado Livre nas amarelas, "tente novamente" em vinho, aro vermelho com bordas douradas e pisca-pisca
 * (verde/dourado/branco quente). Textos e logo no sentido do raio, do centro PARA FORA: assim a fatia
 * que para no ponteiro do "GIRE" (que aponta para a DIREITA) fica com o texto de pé, lido normalmente.
 *
 * 13 fatias de 360/13 = 27.69deg; a fatia k fica centrada em k*27.69 graus (sentido horário, a partir do topo).
 * O giro é feito pelo CSS (css/roleta-1111.css): a fatia sob o ponteiro fica em 90 - giro:
 *   1º giro para em 1280.77deg -> % 360 = 200.77 -> 90 - 200.77 = -110.77 = 249.23deg = fatia 9 (TENTE NOVAMENTE)
 *   2º giro para em 2610deg    -> % 360 =  90    -> 90 - 90     =    0               = fatia 0 (95%)
 * Mudou a quantidade/ordem das fatias? Mantenha 95% na posição 0 e recalcule o 1º giro no CSS:
 *   giro = 90 - (posição do "tente novamente" * 360/N) + 1080  (somando 360 até ficar positivo).
 */
(function () {
  // Tema de Natal (16/11) no padrão da arte. A versão 11.11 (amarelo/azul) está em front/_temas/roleta-1111-roda-20261116.js.
  var AMARELO = '#ffe600', VERMELHO = '#d7182a', VINHO = '#a10e1e', DOURADO = '#f2c14e';
  var TEXTO = {};
  TEXTO[AMARELO] = '#b3101f'; TEXTO[VERMELHO] = '#ffffff'; TEXTO[VINHO] = AMARELO;
  var LUZES = ['#3ddc6b', '#ffd23f', '#fff4c2'];   // pisca-pisca: verde, dourada, branca quente (em sequência no aro)

  // amarelo e vermelho alternados; os 2 "tente novamente" em vinho (nunca amarelos: a logo bateria no texto).
  // Com 13 fatias (ímpar) uma dupla fica sem amarelo no meio: a 8 (vermelho) encosta na 9 (vinho).
  var FATIAS = [
    { pct: '95%', cor: VERMELHO },     //  0  <- prêmio (2º giro)
    { pct: '10%', cor: AMARELO },      //  1
    { pct: '5%',  cor: VERMELHO },     //  2
    { pct: '50%', cor: AMARELO },      //  3
    { tente: true, cor: VINHO },       //  4
    { pct: '15%', cor: AMARELO },      //  5
    { pct: '75%', cor: VERMELHO },     //  6
    { pct: '30%', cor: AMARELO },      //  7
    { pct: '25%', cor: VERMELHO },     //  8
    { tente: true, cor: VINHO },       //  9  <- 1º giro
    { pct: '20%', cor: AMARELO },      // 10
    { pct: '60%', cor: VERMELHO },     // 11
    { pct: '40%', cor: AMARELO }       // 12
  ];
  var N = FATIAS.length, PASSO = 2 * Math.PI / N;
  var FONTE = "'Inter', 'Helvetica Neue', Arial, sans-serif";

  var canvas = document.getElementById('roda');
  if (!canvas || !canvas.getContext) return;
  var logo = new Image();
  logo.src = '/assets/images/roleta/ml-aperto.webp';

  function desenha() {
    var css = canvas.offsetWidth || canvas.parentNode.clientWidth || 320;   // offsetWidth ignora a rotação
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var S = Math.round(css * dpr);
    if (canvas.width !== S) { canvas.width = S; canvas.height = S; }
    var ctx = canvas.getContext('2d');
    var c = S / 2, R = S * 0.47, Rs = R * 0.9;                    // aro mais largo que o do 11.11 (0.93) p/ caber o pisca-pisca
    ctx.clearRect(0, 0, S, S);

    // aro: borda dourada de fora (com a sombra) + faixa vermelha + filete dourado de dentro, como na arte
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = S * 0.03; ctx.shadowOffsetY = S * 0.01;
    ctx.fillStyle = DOURADO;
    ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    var Ra = R * 0.985;                                            // fim da faixa vermelha (sobra a borda dourada)
    var aro = ctx.createLinearGradient(0, c - R, 0, c + R);
    aro.addColorStop(0, '#e8323f'); aro.addColorStop(0.55, '#b8121f'); aro.addColorStop(1, '#7e0a14');
    ctx.fillStyle = aro;
    ctx.beginPath(); ctx.arc(c, c, Ra, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = DOURADO;
    ctx.beginPath(); ctx.arc(c, c, Rs * 1.022, 0, Math.PI * 2); ctx.fill();

    // pisca-pisca no aro vermelho (3 por fatia, cores em sequência)
    var k, a, rl = (Ra + Rs * 1.022) / 2, rb = R * 0.017, NL = N * 3;
    for (k = 0; k < NL; k++) {
      a = k * 2 * Math.PI / NL - Math.PI / 2;
      var lx = c + rl * Math.cos(a), ly = c + rl * Math.sin(a);
      ctx.save();
      ctx.shadowColor = LUZES[k % 3]; ctx.shadowBlur = rb * 2.2;
      ctx.fillStyle = LUZES[k % 3];
      ctx.beginPath(); ctx.arc(lx, ly, rb, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,.75)';                  // brilho da lâmpada
      ctx.beginPath(); ctx.arc(lx - rb * 0.3, ly - rb * 0.3, rb * 0.35, 0, Math.PI * 2); ctx.fill();
    }

    // fatias
    for (k = 0; k < N; k++) {
      var meio = k * PASSO - Math.PI / 2;                       // ângulo do canvas (0 = direita)
      ctx.fillStyle = FATIAS[k].cor;
      ctx.beginPath(); ctx.moveTo(c, c);
      ctx.arc(c, c, Rs, meio - PASSO / 2, meio + PASSO / 2);
      ctx.closePath(); ctx.fill();
    }
    // divisórias finas
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = Math.max(1, S * 0.0025);
    for (k = 0; k < N; k++) {
      a = k * PASSO - Math.PI / 2 - PASSO / 2;
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Rs * Math.cos(a), c + Rs * Math.sin(a)); ctx.stroke();
    }

    // conteúdo: eixo x = do centro para a borda (fica de pé quando a fatia está no ponteiro, à direita)
    for (k = 0; k < N; k++) {
      var f = FATIAS[k], cor = f.cor, amarela = cor === AMARELO;
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(k * PASSO - Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = TEXTO[cor];
      if (amarela && logo.complete && logo.naturalWidth) {
        var lw = Rs * 0.235, lh = lw * logo.naturalHeight / logo.naturalWidth;
        ctx.drawImage(logo, Rs * 0.835 - lw / 2, -lh / 2, lw, lh);   // logo encostada na borda
      }
      if (!amarela) { ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = S * 0.006; }   // texto branco legível no vermelho/verde
      if (f.tente) {
        ctx.font = '900 ' + (Rs * 0.064) + 'px ' + FONTE;
        ctx.fillText('TENTE', Rs * 0.61, -Rs * 0.04);
        ctx.fillText('NOVAMENTE', Rs * 0.61, Rs * 0.04);
      } else {
        var rc = amarela ? Rs * 0.505 : Rs * 0.615;               // valor mais para o centro (nas amarelas, antes da logo)
        var tam = amarela ? Rs * 0.12 : Rs * 0.14;
        ctx.font = '900 ' + tam + 'px ' + FONTE;
        ctx.fillText(f.pct, rc, -tam * 0.2);
        ctx.font = '800 ' + (tam * 0.34) + 'px ' + FONTE;
        ctx.fillText('DESCONTO', rc, tam * 0.48);
      }
      ctx.restore();
    }

    // sombra interna perto do aro (dá volume, como na arte)
    var sombra = ctx.createRadialGradient(c, c, Rs * 0.80, c, c, Rs);
    sombra.addColorStop(0, 'rgba(0,0,0,0)'); sombra.addColorStop(1, 'rgba(0,0,0,.16)');
    ctx.fillStyle = sombra;
    ctx.beginPath(); ctx.arc(c, c, Rs, 0, Math.PI * 2); ctx.fill();
  }

  desenha();
  logo.onload = desenha;
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('900 20px Inter'), document.fonts.load('800 20px Inter')]).then(desenha, function () {});
  }
  var t;
  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(desenha, 120); });
})();
