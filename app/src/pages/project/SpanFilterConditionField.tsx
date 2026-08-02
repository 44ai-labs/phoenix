import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { autocompletion } from "@codemirror/autocomplete";
import { python } from "@codemirror/lang-python";
import { css } from "@emotion/react";
import type { EditorView } from "@uiw/react-codemirror";
import CodeMirror, {
  type BasicSetupOptions,
  keymap,
} from "@uiw/react-codemirror";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AgentContext } from "@phoenix/agent/context/agentContextTypes";
import { useAdvertiseAgentContext } from "@phoenix/agent/context/useAdvertiseAgentContext";
import {
  Button,
  DialogTrigger,
  Flex,
  Icon,
  IconButton,
  Icons,
  Label,
  Popover,
  Text,
  Tooltip,
  TooltipTrigger,
  View,
} from "@phoenix/components";
import { pierreDark, pierreLight } from "@phoenix/components/code";
import { fieldBaseCSS } from "@phoenix/components/core/field/styles";
import { useTheme } from "@phoenix/contexts";
import { useTracingContext } from "@phoenix/contexts/TracingContext";

import { useSpanFilters } from "./SpanFiltersContext";
import { validateSpanFilterCondition } from "./spanFilterValidation";

const codeMirrorCSS = css`
  flex: 1 1 auto;
  .cm-content {
    padding: var(--global-dimension-static-size-100) 0;
  }
  .cm-editor {
    background-color: transparent !important;
  }
  .cm-focused {
    outline: none;
  }
  .cm-selectionLayer .cm-selectionBackground {
    background: var(--global-color-cyan-400) !important;
  }
`;

const fieldCSS = css`
  border-width: var(--global-border-size-thin);
  border-style: solid;
  border-color: var(--global-input-field-border-color);
  border-radius: var(--global-rounding-small);
  background-color: var(--global-input-field-background-color);
  transition: all 0.2s ease-in-out;
  overflow-x: hidden;
  &:hover,
  &[data-is-focused="true"] {
    border-color: var(--global-input-field-border-color-active);
  }
  &[data-is-invalid="true"] {
    border-color: var(--global-color-danger);
  }
  &[data-is-active="true"] {
    border-color: var(--global-color-primary-700);
  }
  &[data-is-active="true"]:hover,
  &[data-is-active="true"][data-is-focused="true"] {
    border-color: var(--global-color-primary-900);
  }
  box-sizing: border-box;
  .search-icon {
    margin-left: var(--global-dimension-static-size-100);
  }
`;

const enterHintCSS = css`
  font-size: 11px;
  color: var(--global-text-color-500);
  padding-right: var(--global-dimension-static-size-100);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0.7;
`;

const activeBadgeCSS = css`
  font-size: 11px;
  font-weight: 500;
  color: var(--global-color-primary-700);
  padding: 1px 6px;
  border: 1px solid var(--global-color-primary-700);
  border-radius: 10px;
  margin-right: var(--global-dimension-static-size-50);
  white-space: nowrap;
  pointer-events: none;
`;

function filterConditionCompletions(
  context: CompletionContext
): CompletionResult | null {
  const word = context.matchBefore(/\w*/);
  if (!word) return null;

  if (word.from === word.to && !context.explicit) return null;

  return {
    from: word.from,
    options: [
      {
        label: "span_kind",
        type: "variable",
        info: "The span variant: CHAIN, LLM, RETRIEVER, TOOL, etc.",
      },
      {
        label: "status_code",
        type: "variable",
        info: "The span status: OK, UNSET, or ERROR",
      },
      {
        label: "input.value",
        type: "variable",
        info: "The input value of a span, typically a query",
      },
      {
        label: "output.value",
        type: "variable",
        info: "The output value of a span, typically a response",
      },
      {
        label: "name",
        type: "variable",
        info: "The name given to a span - e.x. OpenAI",
      },
      {
        label: "latency_ms",
        type: "variable",
        info: "Latency (i.e. duration) in milliseconds",
      },
      {
        label: "cumulative_token_count.prompt",
        type: "variable",
        info: "Sum of token count for prompt from self and all child spans",
      },
      {
        label: "cumulative_token_count.completion",
        type: "variable",
        info: "Sum of token count for completion from self and all child spans",
      },
      {
        label: "cumulative_token_count.total",
        type: "variable",
        info: "Sum of token count total (prompt + completion) from self and all child spans",
      },
      {
        label: "llm spans",
        type: "text",
        apply: "span_kind == 'LLM'",
        detail: "macro",
      },
      {
        label: "retriever spans",
        type: "text",
        apply: "span_kind == 'RETRIEVER'",
        detail: "macro",
      },
      {
        label: "search input",
        type: "text",
        apply: "'' in input.value",
        detail: "macro",
      },
      {
        label: "search output",
        type: "text",
        apply: "'' in output.value",
        detail: "macro",
      },
      {
        label: "status_code error",
        type: "text",
        apply: "status_code == 'ERROR'",
        detail: "macro",
      },
      {
        label: "Latency >= 10s",
        type: "text",
        apply: "latency_ms >= 10_000",
        detail: "macro",
      },
      {
        label: "Tokens >= 1,000",
        type: "text",
        apply: "llm.token_count.total >= 1_000",
        detail: "macro",
      },
      {
        label: "Hallucinations",
        type: "text",
        apply: "annotations['Hallucination'].label == 'hallucinated'",
        detail: "macro",
      },
      {
        label: "Annotations",
        type: "text",
        apply: "annotations['Hallucination'].label == 'hallucinated'",
        detail: "macro",
      },
      {
        label: "Metadata",
        type: "text",
        apply: "metadata['topic'] == 'agent'",
        detail: "macro",
      },
      {
        label: "Substring",
        type: "text",
        apply: "'agent' in input.value",
        detail: "macro",
      },
    ],
  };
}

// Stable base — Enter keymap is wired per-instance via a ref (see below)
const baseExtensions = [
  python(),
  autocompletion({ override: [filterConditionCompletions] }),
];

const basicSetupOptions: BasicSetupOptions = {
  lineNumbers: false,
  foldGutter: false,
  bracketMatching: true,
  syntaxHighlighting: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  defaultKeymap: false,
  searchKeymap: false,
};

type SpanFilterConditionFieldProps = {
  /**
   * Callback when the condition is valid
   */
  onValidCondition: (condition: string) => void;
  placeholder?: string;
};
export function SpanFilterConditionField(props: SpanFilterConditionFieldProps) {
  const {
    onValidCondition,
    placeholder = "filter condition (e.x. span_kind == 'LLM')",
  } = props;
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [isConditionValidState, setIsConditionValidState] =
    useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const { filterCondition, setFilterCondition, appendFilterCondition } =
    useSpanFilters();
  const deferredFilterCondition = useDeferredValue(filterCondition);
  const { theme } = useTheme();
  const codeMirrorTheme = theme === "light" ? pierreLight : pierreDark;

  const projectId = useTracingContext((state) => state.projectId);

  const filterConditionFieldRef = useRef<HTMLDivElement>(null);

  // What was last submitted — drives the "active" indicator
  const [committedCondition, setCommittedCondition] = useState<string>("");

  // Refs so the stable keymap extension can always see current values
  const filterConditionRef = useRef(filterCondition);
  filterConditionRef.current = filterCondition;
  const isValidRef = useRef(isConditionValidState);
  isValidRef.current = isConditionValidState;
  const onValidConditionRef = useRef(onValidCondition);
  onValidConditionRef.current = onValidCondition;
  const setCommittedConditionRef = useRef(setCommittedCondition);
  setCommittedConditionRef.current = setCommittedCondition;

  // Per-instance extensions: Enter commits the search, never inserts a newline
  const extensions = useMemo(
    () => [
      keymap.of([
        {
          key: "Enter",
          run: (_editorView: EditorView) => {
            if (isValidRef.current) {
              const condition = filterConditionRef.current;
              setCommittedConditionRef.current(condition);
              startTransition(() => {
                onValidConditionRef.current(condition);
              });
            }
            return true;
          },
        },
      ]),
      ...baseExtensions,
    ],
    [] // stable — current values read through refs
  );

  const advertisedContext = useMemo<AgentContext | null>(() => {
    // Advertise a project context that carries the current spanFilter while
    // the field is mounted. The merge in `selectActiveContexts` layers this
    // on top of the route-derived project context (which carries no filter)
    // so the server sees a single project entry with the filter included.
    // An in-progress invalid edit surfaces as empty rather than a known-bad
    // expression.
    if (!projectId) {
      return null;
    }
    const trimmed = deferredFilterCondition.trim();
    const spanFilter = isConditionValidState && trimmed ? trimmed : "";
    return {
      type: "project",
      projectNodeId: projectId,
      spanFilter,
    };
  }, [deferredFilterCondition, isConditionValidState, projectId]);

  // Keep the agent's mounted UI context aligned with the current validated
  // filter expression while this field is rendered. The matching agent
  // client action for `set_spans_filter` is registered by
  // `SpanFiltersProvider`, which owns the underlying state.
  useAdvertiseAgentContext(advertisedContext);

  // Validate on every keystroke — updates error UI only, does NOT fire search.
  // Search is triggered explicitly by pressing Enter (see keymap above).
  useEffect(() => {
    let isCancelled = false;

    if (deferredFilterCondition.trim() !== "") {
      setIsConditionValidState(false);
    }

    void validateSpanFilterCondition(deferredFilterCondition, projectId).then(
      (result) => {
        if (isCancelled) {
          return;
        }

        if (!result?.isValid) {
          setErrorMessage(result?.errorMessage ?? "Invalid filter condition");
          setIsConditionValidState(false);
        } else {
          setErrorMessage("");
          setIsConditionValidState(true);
        }
      }
    );

    return () => {
      isCancelled = true;
    };
  }, [deferredFilterCondition, projectId]);

  // When the filter is cleared (X button or external reset), immediately
  // propagate the empty condition so the table resets without requiring Enter.
  const prevFilterConditionRef = useRef(filterCondition);
  useEffect(() => {
    if (filterCondition === "" && prevFilterConditionRef.current !== "") {
      setCommittedCondition("");
      startTransition(() => {
        onValidCondition("");
      });
    }
    prevFilterConditionRef.current = filterCondition;
  }, [filterCondition, onValidCondition]);

  const hasError = errorMessage !== "";
  const hasCondition = filterCondition !== "";
  const isSearchActive = committedCondition !== "";
  const isPending =
    filterCondition.trim() !== "" && filterCondition !== committedCondition;
  return (
    <div
      data-is-focused={isFocused}
      data-is-invalid={hasError}
      data-is-active={isSearchActive && !isPending}
      className="span-filter-condition-field"
      css={fieldCSS}
      ref={filterConditionFieldRef}
    >
      <Flex direction="row" alignItems="center">
        <Icon svg={<Icons.Search />} className="search-icon" />
        <CodeMirror
          css={codeMirrorCSS}
          indentWithTab={false}
          basicSetup={basicSetupOptions}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          value={filterCondition}
          onChange={setFilterCondition}
          height="36px"
          width="100%"
          theme={codeMirrorTheme}
          placeholder={placeholder}
          extensions={extensions}
        />
        {isPending && isConditionValidState && (
          <span css={enterHintCSS}>↵ to search</span>
        )}
        {isSearchActive && !isPending && (
          <span css={activeBadgeCSS}>active</span>
        )}
        <button
          css={css`
            margin-right: var(--global-dimension-static-size-100);
            color: var(--global-text-color-700);
            visibility: ${hasCondition ? "visible" : "hidden"};
          `}
          onClick={() => setFilterCondition("")}
          className="button--reset"
        >
          <Icon svg={<Icons.CloseCircle />} />
        </button>
        <DialogTrigger>
          <IconButton
            css={css`
              color: var(--global-text-color-700);
              border-left: 1px solid var(--global-input-field-border-color);
              border-bottom: 0;
              border-top: 0;
              padding-left: var(--global-dimension-static-size-100);
              padding-right: var(--global-dimension-static-size-100);
              border-radius: 0;
              height: 36px !important;
            `}
            className="button--reset"
          >
            <Icon svg={<Icons.Plus />} />
          </IconButton>
          <Popover placement="bottom right">
            <FilterConditionBuilder
              onAddFilterConditionSnippet={appendFilterCondition}
            />
          </Popover>
        </DialogTrigger>
      </Flex>
      <TooltipTrigger isOpen={hasError && isFocused}>
        <Tooltip placement="bottom" triggerRef={filterConditionFieldRef}>
          {errorMessage !== "" ? (
            <Text color="danger">{errorMessage}</Text>
          ) : (
            <Text color="success">Valid Expression</Text>
          )}
        </Tooltip>
      </TooltipTrigger>
    </div>
  );
}

/**
 * Component to build up a filter condition via snippets of conditions
 * E.x. filter by kind, filter by token count, etc.
 */
function FilterConditionBuilder(props: {
  onAddFilterConditionSnippet: (condition: string) => void;
}) {
  const { onAddFilterConditionSnippet } = props;
  return (
    <View
      width="500px"
      padding="size-200"
      borderRadius="medium"
      backgroundColor="gray-75"
    >
      <Flex direction="column" gap="size-100">
        <FilterConditionSnippet
          key="kind"
          label="filter by kind"
          initialSnippet="span_kind == 'LLM'"
          onAddFilterConditionSnippet={onAddFilterConditionSnippet}
        />
        <FilterConditionSnippet
          key="token_count"
          label="filter by token count"
          initialSnippet="cumulative_token_count.total > 1000"
          onAddFilterConditionSnippet={onAddFilterConditionSnippet}
        />
        <FilterConditionSnippet
          key="annotation_label"
          label="filter by annotation label"
          initialSnippet="annotations['Hallucination'].label == 'hallucinated'"
          onAddFilterConditionSnippet={onAddFilterConditionSnippet}
        />
        <FilterConditionSnippet
          key="eval_label"
          label="filter by evaluation label"
          initialSnippet="evals['Hallucination'].label == 'hallucinated'"
          onAddFilterConditionSnippet={onAddFilterConditionSnippet}
        />
        <FilterConditionSnippet
          key="eval_score"
          label="filter by evaluation score"
          initialSnippet="evals['Hallucination'].score < 1"
          onAddFilterConditionSnippet={onAddFilterConditionSnippet}
        />
        <FilterConditionSnippet
          key="metadata"
          label="filter by metadata"
          initialSnippet="metadata['topic'] == 'agent'"
          onAddFilterConditionSnippet={onAddFilterConditionSnippet}
        />
        <FilterConditionSnippet
          key="substring"
          label="filter by substring"
          initialSnippet="'agent' in input.value"
          onAddFilterConditionSnippet={onAddFilterConditionSnippet}
        />
      </Flex>
    </View>
  );
}

/**
 * A snippet of filter condition that can be added to the filter condition field
 */
function FilterConditionSnippet(props: {
  label: string;
  initialSnippet: string;
  onAddFilterConditionSnippet: (condition: string) => void;
}) {
  const { initialSnippet, onAddFilterConditionSnippet } = props;
  const [snippet, setSnippet] = useState<string>(initialSnippet);
  const { theme } = useTheme();
  const codeMirrorTheme = theme === "light" ? pierreLight : pierreDark;
  return (
    <div css={fieldBaseCSS}>
      <Label>{props.label}</Label>
      <Flex direction="row" width="100%" gap="size-100">
        <div
          css={css(
            fieldCSS,
            css`
              flex: 1 1 auto;
            `
          )}
        >
          <CodeMirror
            value={snippet}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              bracketMatching: true,
              syntaxHighlighting: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
            }}
            extensions={[python()]}
            editable={true}
            onChange={setSnippet}
            theme={codeMirrorTheme}
            css={codeMirrorCSS}
          />
        </div>
        <Button
          aria-label="Add to filter condition"
          variant="default"
          onPress={() => onAddFilterConditionSnippet(snippet)}
          leadingVisual={<Icon svg={<Icons.PlusCircle />} />}
        />
      </Flex>
    </div>
  );
}
