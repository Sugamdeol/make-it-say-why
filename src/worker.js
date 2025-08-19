/**
 * =================================================================
 * Cognitive Orchestrator on Cloudflare Workers
 * 
 * This is the complete file with the CORS (Cross-Origin Resource Sharing)
 * fix implemented. It handles preflight OPTIONS requests and adds the
 * necessary headers to all responses.
 * =================================================================
 */

// Helper function to add CORS headers to a response
function addCorsHeaders(response) {
  response.headers.set('Access-Control-Allow-Origin', '*'); // Allow any origin to access
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS'); // Allow these HTTP methods
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Allow these headers
  return response;
}

export default {
  async fetch(request, env) {
    // --- CORS Preflight Request Handling ---
    // The browser sends an OPTIONS request first to check if the server will allow
    // a request from a different origin. We handle that here.
    if (request.method === 'OPTIONS') {
      return addCorsHeaders(new Response(null, { status: 204 })); // 204 No Content
    }

    const url = new URL(request.url);

    // Basic routing for our API endpoint
    if (url.pathname !== '/v1/reason' || request.method !== 'POST') {
      const notFoundResponse = new Response('Not Found. Please POST to /v1/reason', { status: 404 });
      return addCorsHeaders(notFoundResponse); // Add CORS headers even to error responses
    }

    try {
      const body = await request.json();

      // --- Input Validation ---
      if (!body.query || !body.model) {
        const badRequestResponse = new Response(JSON.stringify({
          status: 'error',
          message: 'Missing required fields: `query` and `model` are required.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
        return addCorsHeaders(badRequestResponse);
      }

      // --- Initialization ---
      const reasoning_trace = [];
      const usage = {
        backend_model: body.model,
        total_prompt_tokens: 0,
        total_completion_tokens: 0,
        api_calls: 0,
      };

      const strategy = body.strategy || 'auto';
      let final_answer = '';

      // --- Strategy Selection ---
      let chosen_strategy = strategy;
      if (strategy === 'auto') {
        if (body.query.toLowerCase().includes('plan') || body.query.toLowerCase().includes('steps')) {
          chosen_strategy = 'decompose';
        } else {
          chosen_strategy = 'chain_of_thought';
        }
      }
      reasoning_trace.push({ step: 1, type: 'strategy_selection', content: `Strategy '${strategy}' selected. Executing as '${chosen_strategy}'.` });

      // --- Execute Strategy ---
      switch (chosen_strategy) {
        case 'decompose':
          final_answer = await runDecompositionStrategy(body, env, reasoning_trace, usage);
          break;
        case 'self_correct':
          final_answer = await runSelfCorrectionStrategy(body, env, reasoning_trace, usage);
          break;
        case 'chain_of_thought':
        default:
          final_answer = await runChainOfThoughtStrategy(body, env, reasoning_trace, usage);
          break;
      }
      
      // --- Final Response ---
      const responsePayload = {
        status: 'success',
        final_answer,
        reasoning_trace,
        usage,
      };

      const successResponse = new Response(JSON.stringify(responsePayload, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
      
      // Add CORS headers to the final successful response
      return addCorsHeaders(successResponse);

    } catch (error) {
      console.error('Error in worker:', error);
      const errorResponse = new Response(JSON.stringify({ status: 'error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
      // Add CORS headers to the server error response
      return addCorsHeaders(errorResponse);
    }
  },
};

/**
 * A centralized helper to call the Pollinations.AI API.
 * It handles authentication, payload formatting, and usage tracking.
 */
async function callPollinationsAPI(messages, model, env, usage) {
	const headers = {
		'Content-Type': 'application/json',
	};
	if (env.POLLINATIONS_TOKEN) {
		headers['Authorization'] = `Bearer ${env.POLLINATIONS_TOKEN}`;
	}

	const response = await fetch(env.POLLINATIONS_BASE_URL, {
		method: 'POST',
		headers: headers,
		body: JSON.stringify({
			model: model,
			messages: messages,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Pollinations API Error: ${response.status} ${response.statusText} - ${errorText}`);
	}

	const data = await response.json();
	usage.api_calls++;
	if (data.usage) {
		usage.total_prompt_tokens += data.usage.prompt_tokens || 0;
		usage.total_completion_tokens += data.usage.completion_tokens || 0;
	}

	return data.choices[0].message.content;
}

// --- STRATEGY IMPLEMENTATIONS ---

async function runChainOfThoughtStrategy(body, env, reasoning_trace, usage) {
	const { query, model, context } = body;
	let step = reasoning_trace.length + 1;

	reasoning_trace.push({ step, type: 'thought', content: "Applying Chain-of-Thought. I will think step-by-step to arrive at the answer." });

	const system_prompt = `You are a world-class reasoning expert. Solve the following problem by thinking step-by-step. First, lay out your reasoning, then provide the final answer.
	${context ? `Here is some background context: ${context}` : ''}`;
	
	const messages = [
		{ role: 'system', content: system_prompt },
		{ role: 'user', content: query },
	];

	const response = await callPollinationsAPI(messages, model, env, usage);
	reasoning_trace.push({ step: step + 1, type: 'llm_response', content: response });
	return response;
}

async function runSelfCorrectionStrategy(body, env, reasoning_trace, usage) {
	const { query, model, context } = body;
	let step = reasoning_trace.length + 1;

	// 1. Initial Draft
	reasoning_trace.push({ step, type: 'thought', content: "Generating an initial draft." });
	const draft_messages = [
		{ role: 'system', content: `Directly answer the following user query. ${context ? `Context: ${context}` : ''}` },
		{ role: 'user', content: query },
	];
	const initial_draft = await callPollinationsAPI(draft_messages, model, env, usage);
	reasoning_trace.push({ step: step + 1, type: 'draft', content: initial_draft });
	step += 2;

	// 2. Critique
	reasoning_trace.push({ step, type: 'thought', content: "Now, I will critique the draft for flaws, errors, or missing information." });
	const critique_messages = [
		{ role: 'system', content: "You are a meticulous critic. Analyze the following solution for flaws, logical errors, or missing details. Be specific in your critique. Do not solve the problem yourself, only critique the provided solution." },
		{ role: 'user', content: `Original Problem: "${query}"\n\nProvided Solution: "${initial_draft}"\n\nYour Critique:` },
	];
	const critique = await callPollinationsAPI(critique_messages, model, env, usage);
	reasoning_trace.push({ step: step + 1, type: 'critique', content: critique });
	step += 2;

	// 3. Refine
	reasoning_trace.push({ step, type: 'thought', content: "Finally, I will generate a new, improved answer based on the critique." });
	const refine_messages = [
		{ role: 'system', content: "You are an expert who refines answers. Based on the provided critique, create a final, improved answer to the original problem." },
		{ role: 'user', content: `Original Problem: "${query}"\n\nInitial Solution: "${initial_draft}"\n\nCritique of Solution: "${critique}"\n\nImproved Final Answer:` },
	];
	const final_answer = await callPollinationsAPI(refine_messages, model, env, usage);
	
	return final_answer;
}

async function runDecompositionStrategy(body, env, reasoning_trace, usage) {
	const { query, model, context } = body;
	let step = reasoning_trace.length + 1;

	// 1. Decompose into sub-problems
	reasoning_trace.push({ step, type: 'thought', content: "Task is complex. Decomposing it into smaller, manageable sub-problems." });
	const decompose_messages = [
		{ role: 'system', content: "You are an expert planner. Break the following complex task into a short, numbered list of smaller, sequential sub-problems that can be solved one by one. Output ONLY the numbered list of problems." },
		{ role: 'user', content: `${context ? `Context: ${context}\n\n` : ''}Task: ${query}` },
	];
	const decomposition_response = await callPollinationsAPI(decompose_messages, model, env, usage);
	const sub_problems = decomposition_response.split('\n').map(s => s.trim()).filter(s => s.match(/^\d+\./));
	
	if (sub_problems.length === 0) {
		reasoning_trace.push({ step: step+1, type: 'error', content: 'Decomposition failed. Could not extract sub-problems. Falling back to Chain of Thought.' });
		return runChainOfThoughtStrategy(body, env, reasoning_trace, usage);
	}
	
	reasoning_trace.push({ step: step + 1, type: 'sub_problem_decomposition', content: sub_problems });
	step += 2;

	// 2. Solve each sub-problem sequentially
	const sub_solutions = [];
	for (const problem of sub_problems) {
		reasoning_trace.push({ step, type: 'thought', content: `Solving sub-problem: "${problem}"` });
		const sub_problem_messages = [
			{ role: 'system', content: `You are an expert problem solver. Given the original task, context, and previous solutions, solve the CURRENT sub-problem concisely.` },
			{ role: 'user', content: `Original Task: ${query}\n\n${context ? `Context: ${context}\n\n` : ''}Previous Solutions:\n${sub_solutions.map((s, i) => `${i+1}. ${s}`).join('\n') || 'None yet.'}\n\nCURRENT Sub-Problem to Solve: ${problem}` },
		];
		const solution = await callPollinationsAPI(sub_problem_messages, model, env, usage);
		sub_solutions.push(solution);
		reasoning_trace.push({ step: step + 1, type: 'sub_problem_solution', details: { problem, solution } });
		step += 2;
	}

	// 3. Synthesize the final answer
	reasoning_trace.push({ step, type: 'thought', content: "All sub-problems solved. Synthesizing the final answer." });
	const synthesis_messages = [
		{ role: 'system', content: "You are an expert synthesizer. Combine the following solutions to individual sub-problems into a single, cohesive, and comprehensive final answer for the original user query. Do not list the sub-problems again; integrate them into a final narrative or plan." },
		{ role: 'user', content: `Original Query: "${query}"\n\nHere are the solved pieces:\n${sub_solutions.map((s, i) => `Solution to problem #${i+1}:\n${s}`).join('\n\n')}\n\nSynthesized Final Answer:` },
	];
	const final_answer = await callPollinationsAPI(synthesis_messages, model, env, usage);

	return final_answer;
}
