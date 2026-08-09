// Translation dictionary + language/theme switching. No framework, no build
// step -- GitHub Pages serves this directory as-is.
(function () {
  "use strict";

  var STRINGS = {
    en: {
      "hero.eyebrow": "Agent Tools Runtime",
      "hero.h1": "Give your agent a thousand tools.<br><em>Load none of them until it asks.</em>",
      "hero.sub": "A small, persistent runtime that lets AI agents discover and connect to real services on demand — instead of loading every tool’s manual into every conversation.",
      "hero.cta.github": "View on GitHub",
      "hero.cta.npm": "npm install",
      "hero.stage.label": "live patch simulation",

      "problem.eyebrow": "The problem",
      "problem.h2": "Every tool, every time — whether you need it or not",
      "problem.lede": "The usual way to connect an agent to a service is to hand it the full manual before every single question: every endpoint, every argument, every edge case. Whether the conversation needs three of them or none, they all load anyway.",
      "problem.bad.title": "Wired permanently",
      "problem.bad.caption": "Every tool’s full instructions, loaded into every conversation, used or not.",
      "problem.good.title": "Connected on demand",
      "problem.good.caption": "A short menu first. Full instructions arrive only for what actually gets used.",

      "how.eyebrow": "How it works",
      "how.h2": "Ask first. Load exactly what answers.",
      "how.lede": "Every plugin exposes the same three jacks, no matter what it connects to underneath.",
      "how.step1.title": "Say what you need",
      "how.step1.body": "The agent asks a small, cheap question: “what can you do with GitHub?”",
      "how.step2.title": "Get a short list back",
      "how.step2.body": "The runtime answers with the handful of things that matter — not the whole catalog.",
      "how.step3.title": "Pick the exact one",
      "how.step3.body": "The agent chooses the capability that actually fits the task in front of it.",
      "how.step4.title": "Only then, load it",
      "how.step4.body": "The full instructions for that one thing arrive. Nothing else does.",
      "how.fact": "Every connected service gets the same three doors in — <strong>discover</strong>, <strong>call</strong>, <strong>run a ready-made recipe</strong> — whether it wraps 4 endpoints or 300.",

      "rack.eyebrow": "The plugin rack",
      "rack.h2": "Eight real connections, four ways of talking",
      "rack.lede": "Every module below runs against the real service it connects to — not a mockup.",

      "plugin.n8n.desc": "Build, run, and audit your n8n automations — including a scan for risky workflow configurations.",
      "plugin.github.desc": "Repos, issues, and commits — one call gives back the summary that used to take ten.",
      "plugin.ghcli.desc": "The same GitHub data, but through the gh command-line tool instead of a raw API call.",
      "plugin.pocketbase.desc": "Talks to a self-hosted PocketBase backend: create a record, then read it back to confirm.",
      "plugin.tasks.desc": "A minimal to-do list API — the simplest possible example of what a plugin can be.",
      "plugin.kitelite.desc": "Drives a lightweight browser engine: fetch a page, click around, take a screenshot.",
      "plugin.ccdd.desc": "Deterministic Python code-quality gates — real AST checks, no guessing — plus a way to delegate implementation to a small model and grade it automatically.",
      "plugin.ollama.desc": "Talks to language models, local or cloud: generate text, start a job in the background, check on it later.",

      "builders.eyebrow": "For builders",
      "builders.h2": "Already have an API? You don’t need to stand up a server to make it agent-ready.",
      "builders.lede": "A plugin is a folder the runtime loads directly — no hosting, no new process to keep alive, no MCP server to write from scratch.",
      "builders.benefit1.title": "Zero infrastructure.",
      "builders.benefit1.body": "Ship a package that wraps the API you already have. Nothing new to deploy or keep running.",
      "builders.benefit2.title": "Discoverability included.",
      "builders.benefit2.body": "Confirmation on risky calls, error hints, search — all inherited from the runtime, for free.",
      "builders.benefit3.title": "Your own shortcuts.",
      "builders.benefit3.body": "Bundle a multi-step recipe into one reliable call, instead of every agent reinventing it.",
      "builders.cta": "Read the plugin guide",
      "builders.wirecard.title": "connections/agent-tools-runtime.ts",

      "quickstart.eyebrow": "Quick start",
      "quickstart.h2": "Running in one command",
      "quickstart.lede": "Install the runtime, point it at a plugin, and your agent has a new, small menu to ask from.",

      "footer.tagline": "A small, persistent runtime for agents that would rather ask than guess.",
      "footer.license": "MIT License"
    },

    es: {
      "hero.eyebrow": "Agent Tools Runtime",
      "hero.h1": "Dale mil herramientas a tu agente.<br><em>No cargues ninguna hasta que la pida.</em>",
      "hero.sub": "Un runtime pequeño y persistente que deja que los agentes de IA descubran y se conecten a servicios reales bajo demanda — en vez de cargar el manual de cada herramienta en cada conversación.",
      "hero.cta.github": "Ver en GitHub",
      "hero.cta.npm": "Instalar con npm",
      "hero.stage.label": "simulación de conexión en vivo",

      "problem.eyebrow": "El problema",
      "problem.h2": "Todas las herramientas, todo el tiempo — las necesites o no",
      "problem.lede": "La forma habitual de conectar un agente a un servicio es entregarle el manual completo antes de cada pregunta: cada endpoint, cada argumento, cada caso borde. Sin importar si la conversación necesita tres de ellos o ninguno, todos se cargan igual.",
      "problem.bad.title": "Cableado permanente",
      "problem.bad.caption": "Las instrucciones completas de cada herramienta, cargadas en cada conversación, se usen o no.",
      "problem.good.title": "Conectado bajo demanda",
      "problem.good.caption": "Primero, un menú breve. Las instrucciones completas llegan solo para lo que realmente se usa.",

      "how.eyebrow": "Cómo funciona",
      "how.h2": "Primero pregunta. Carga exactamente lo que responde.",
      "how.lede": "Cada plugin expone las mismas tres entradas, sin importar a qué se conecte por dentro.",
      "how.step1.title": "Decí qué necesitás",
      "how.step1.body": "El agente hace una pregunta chica y barata: “¿qué podés hacer con GitHub?”",
      "how.step2.title": "Recibí una lista breve",
      "how.step2.body": "El runtime responde con el puñado de cosas que importan — no todo el catálogo.",
      "how.step3.title": "Elegí la exacta",
      "how.step3.body": "El agente elige la capacidad que realmente encaja con la tarea que tiene enfrente.",
      "how.step4.title": "Recién ahí, cargala",
      "how.step4.body": "Llegan las instrucciones completas de esa única cosa. Nada más.",
      "how.fact": "Cada servicio conectado tiene las mismas tres puertas de entrada — <strong>descubrir</strong>, <strong>llamar</strong>, <strong>correr una receta lista</strong> — ya envuelva 4 endpoints o 300.",

      "rack.eyebrow": "El rack de plugins",
      "rack.h2": "Ocho conexiones reales, cuatro formas de hablar",
      "rack.lede": "Cada módulo de abajo corre contra el servicio real al que se conecta — no es una maqueta.",

      "plugin.n8n.desc": "Construí, corré y auditá tus automatizaciones de n8n — incluyendo un escaneo de configuraciones de workflow riesgosas.",
      "plugin.github.desc": "Repos, issues y commits — una sola llamada devuelve el resumen que antes tomaba diez.",
      "plugin.ghcli.desc": "Los mismos datos de GitHub, pero a través del comando gh en vez de una llamada cruda a la API.",
      "plugin.pocketbase.desc": "Habla con un backend de PocketBase self-hosted: crea un registro y lo vuelve a leer para confirmar.",
      "plugin.tasks.desc": "Una API mínima de lista de tareas — el ejemplo más simple posible de lo que puede ser un plugin.",
      "plugin.kitelite.desc": "Maneja un motor de navegador liviano: trae una página, hace clics, saca una captura.",
      "plugin.ccdd.desc": "Gates deterministas de calidad de código Python — chequeos AST reales, sin adivinar — además de poder delegar la implementación a un modelo chico y calificarla automáticamente.",
      "plugin.ollama.desc": "Habla con modelos de lenguaje, locales o en la nube: genera texto, arranca un job en segundo plano, lo consulta después.",

      "builders.eyebrow": "Para quienes construyen",
      "builders.h2": "¿Ya tenés una API? No necesitás levantar un servidor para que un agente la use.",
      "builders.lede": "Un plugin es una carpeta que el runtime carga directo — sin hosting, sin un proceso nuevo que mantener vivo, sin escribir un servidor MCP desde cero.",
      "builders.benefit1.title": "Cero infraestructura.",
      "builders.benefit1.body": "Empaquetá algo que envuelva la API que ya tenés. Nada nuevo que desplegar ni mantener corriendo.",
      "builders.benefit2.title": "Descubribilidad incluida.",
      "builders.benefit2.body": "Confirmación en llamadas riesgosas, pistas de error, búsqueda — todo heredado del runtime, gratis.",
      "builders.benefit3.title": "Tus propios atajos.",
      "builders.benefit3.body": "Empaquetá una receta de varios pasos en una sola llamada confiable, en vez de que cada agente la reinvente.",
      "builders.cta": "Leé la guía de plugins",
      "builders.wirecard.title": "connections/agent-tools-runtime.ts",

      "quickstart.eyebrow": "Para arrancar",
      "quickstart.h2": "Corriendo en un solo comando",
      "quickstart.lede": "Instalá el runtime, apuntalo a un plugin, y tu agente tiene un menú nuevo y chico para preguntar.",

      "footer.tagline": "Un runtime chico y persistente para agentes que prefieren preguntar antes que adivinar.",
      "footer.license": "Licencia MIT"
    },

    pt: {
      "hero.eyebrow": "Agent Tools Runtime",
      "hero.h1": "Dê mil ferramentas ao seu agente.<br><em>Não carregue nenhuma até que ele peça.</em>",
      "hero.sub": "Um runtime pequeno e persistente que deixa agentes de IA descobrirem e se conectarem a serviços reais sob demanda — em vez de carregar o manual de cada ferramenta em cada conversa.",
      "hero.cta.github": "Ver no GitHub",
      "hero.cta.npm": "Instalar com npm",
      "hero.stage.label": "simulação de conexão ao vivo",

      "problem.eyebrow": "O problema",
      "problem.h2": "Todas as ferramentas, o tempo todo — precise ou não",
      "problem.lede": "A forma comum de conectar um agente a um serviço é entregar o manual inteiro antes de cada pergunta: cada endpoint, cada argumento, cada caso extremo. Não importa se a conversa precisa de três deles ou de nenhum, todos são carregados do mesmo jeito.",
      "problem.bad.title": "Cabeado permanentemente",
      "problem.bad.caption": "As instruções completas de cada ferramenta, carregadas em toda conversa, usadas ou não.",
      "problem.good.title": "Conectado sob demanda",
      "problem.good.caption": "Primeiro, um menu curto. As instruções completas chegam só para o que realmente é usado.",

      "how.eyebrow": "Como funciona",
      "how.h2": "Pergunte primeiro. Carregue exatamente o que responde.",
      "how.lede": "Todo plugin expõe as mesmas três entradas, não importa a que ele se conecte por dentro.",
      "how.step1.title": "Diga o que precisa",
      "how.step1.body": "O agente faz uma pergunta pequena e barata: “o que você consegue fazer com o GitHub?”",
      "how.step2.title": "Receba uma lista curta",
      "how.step2.body": "O runtime responde com o punhado de coisas que importam — não o catálogo inteiro.",
      "how.step3.title": "Escolha a certa",
      "how.step3.body": "O agente escolhe a capacidade que realmente serve para a tarefa em questão.",
      "how.step4.title": "Só então, carregue",
      "how.step4.body": "Chegam as instruções completas daquela única coisa. Mais nada.",
      "how.fact": "Todo serviço conectado tem as mesmas três portas de entrada — <strong>descobrir</strong>, <strong>chamar</strong>, <strong>rodar uma receita pronta</strong> — quer envolva 4 endpoints ou 300.",

      "rack.eyebrow": "O rack de plugins",
      "rack.h2": "Oito conexões reais, quatro formas de falar",
      "rack.lede": "Cada módulo abaixo roda contra o serviço real ao qual se conecta — não é uma maquete.",

      "plugin.n8n.desc": "Construa, rode e audite suas automações do n8n — incluindo uma varredura de configurações de workflow arriscadas.",
      "plugin.github.desc": "Repositórios, issues e commits — uma chamada só devolve o resumo que antes levava dez.",
      "plugin.ghcli.desc": "Os mesmos dados do GitHub, mas através do comando gh em vez de uma chamada crua à API.",
      "plugin.pocketbase.desc": "Conversa com um backend PocketBase self-hosted: cria um registro e o lê de volta para confirmar.",
      "plugin.tasks.desc": "Uma API mínima de lista de tarefas — o exemplo mais simples possível do que um plugin pode ser.",
      "plugin.kitelite.desc": "Controla um motor de navegador leve: busca uma página, clica, tira um print.",
      "plugin.ccdd.desc": "Gates determinísticos de qualidade de código Python — checagens AST reais, sem adivinhação — além de poder delegar a implementação a um modelo pequeno e avaliá-la automaticamente.",
      "plugin.ollama.desc": "Conversa com modelos de linguagem, locais ou na nuvem: gera texto, inicia um job em segundo plano, consulta depois.",

      "builders.eyebrow": "Para quem constrói",
      "builders.h2": "Já tem uma API? Você não precisa subir um servidor para deixá-la pronta para agentes.",
      "builders.lede": "Um plugin é uma pasta que o runtime carrega direto — sem hospedagem, sem um processo novo para manter vivo, sem escrever um servidor MCP do zero.",
      "builders.benefit1.title": "Zero infraestrutura.",
      "builders.benefit1.body": "Publique um pacote que envolve a API que você já tem. Nada novo para implantar ou manter rodando.",
      "builders.benefit2.title": "Descobribilidade inclusa.",
      "builders.benefit2.body": "Confirmação em chamadas arriscadas, dicas de erro, busca — tudo herdado do runtime, de graça.",
      "builders.benefit3.title": "Seus próprios atalhos.",
      "builders.benefit3.body": "Empacote uma receita de vários passos numa única chamada confiável, em vez de cada agente reinventá-la.",
      "builders.cta": "Leia o guia de plugins",
      "builders.wirecard.title": "connections/agent-tools-runtime.ts",

      "quickstart.eyebrow": "Para começar",
      "quickstart.h2": "Rodando em um único comando",
      "quickstart.lede": "Instale o runtime, aponte para um plugin, e seu agente tem um menu novo e enxuto para consultar.",

      "footer.tagline": "Um runtime pequeno e persistente para agentes que preferem perguntar a adivinhar.",
      "footer.license": "Licença MIT"
    }
  };

  var SUPPORTED = ["en", "es", "pt"];

  function detectLang() {
    var stored = localStorage.getItem("atr-lang");
    if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    var nav = (navigator.language || "en").slice(0, 2).toLowerCase();
    return SUPPORTED.indexOf(nav) !== -1 ? nav : "en";
  }

  function applyLang(lang) {
    var dict = STRINGS[lang] || STRINGS.en;
    document.documentElement.setAttribute("lang", lang);
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) el.innerHTML = dict[key];
    });
    document.querySelectorAll(".lang-switch button").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-lang") === lang ? "true" : "false");
    });
    localStorage.setItem("atr-lang", lang);
  }

  function initLangSwitch() {
    var lang = detectLang();
    applyLang(lang);
    document.querySelectorAll(".lang-switch button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        applyLang(btn.getAttribute("data-lang"));
      });
    });
  }

  function initThemeToggle() {
    var root = document.documentElement;
    var stored = localStorage.getItem("atr-theme");
    if (stored === "dark" || stored === "light") root.setAttribute("data-theme", stored);
    var toggle = document.querySelector(".theme-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      localStorage.setItem("atr-theme", next);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLangSwitch();
    initThemeToggle();
  });
})();
