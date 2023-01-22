import {
  SetupContext,
  ExtractPropTypes,
  PropType,
  ref,
  computed,
  watch,
  onMounted,
  nextTick,
  toRef,
  inject,
  provide,
} from 'vue';
import Calendar from '../components/Calendar.vue';
import Popover from '../components/Popover.vue';
import { getDefault } from '../utils/defaults';
import { AttributeConfig } from '../utils/attribute';
import {
  CalendarDay,
  getPageAddressForDate,
  pageIsBetweenPages,
} from '../utils/page';
import {
  isObject,
  isArray,
  isDate,
  defaultsDeep,
  createGuid,
} from '../utils/helpers';
import { DatePatch, DateParts, DatePartsRules } from '../utils/date/helpers';
import { SimpleDateRange } from '../utils/date/range';
import {
  PopoverOptions,
  showPopover as sp,
  hidePopover as hp,
  togglePopover as tp,
  getPopoverEventHandlers,
} from '../utils/popovers';
import { propsDef as basePropsDef, createBase } from './base';
import { MoveTarget, MoveOptions } from './calendar';

export type DateType = 'date' | 'string' | 'number';

export interface DateConfig {
  type: DateType;
  rules: DatePartsRules;
  mask?: string;
}

const contextKey = '__vc_date_picker_context__';

export type DateModes = 'date' | 'datetime' | 'time';

export type ValueTarget = 'none' | 'start' | 'end' | 'both';

export interface UpdateOptions {
  config: any;
  patch: DatePatch;
  debounce: number;
  clearIfEqual: boolean;
  formatInput: boolean;
  hidePopover: boolean;
  dragging: boolean;
  targetPriority: ValueTarget;
  moveToValue: boolean;
  loading: boolean;
}

export interface ModelModifiers {
  number?: boolean;
  string?: boolean;
  range?: boolean;
}

export type DatePickerDate = number | string | Date | null;
export type DatePickerRangeArray = [DatePickerDate, DatePickerDate];
export type DatePickerRangeObject = Partial<{
  start: DatePickerDate;
  end: DatePickerDate;
}>;

export type DatePickerContext = ReturnType<typeof createDatePicker>;

export type DatePickerProps = Readonly<ExtractPropTypes<typeof propsDef>>;

export const propsDef = {
  ...basePropsDef,
  mode: { type: String, default: 'date' },
  modelValue: {
    type: [Number, String, Date, Object] as PropType<
      number | string | Date | DatePickerRangeObject | null
    >,
  },
  modelModifiers: {
    type: Object as PropType<ModelModifiers>,
    default: () => ({}),
  },
  rules: [String, Object] as PropType<'auto' | DatePartsRules>,
  modelConfig: { type: Object, default: () => ({}) },
  is24hr: Boolean,
  hideTimeHeader: Boolean,
  timeAccuracy: { type: Number, default: 2 },
  isRequired: Boolean,
  isRange: Boolean,
  updateOnInput: {
    type: Boolean,
    default: () => getDefault('datePicker.updateOnInput'),
  },
  inputDebounce: {
    type: Number,
    default: () => getDefault('datePicker.inputDebounce'),
  },
  popover: {
    type: [Boolean, Object] as PropType<boolean | Partial<PopoverOptions>>,
    default: true,
  },
  dragAttribute: Object as PropType<AttributeConfig>,
  selectAttribute: Object as PropType<AttributeConfig>,
  attributes: [Object, Array],
};

export const emits = [
  'update:modelValue',
  'drag',
  'dayclick',
  'daykeydown',
  'popover-will-show',
  'popover-did-show',
  'popover-will-hide',
  'popover-did-hide',
];

export function createDatePicker(
  props: DatePickerProps,
  ctx: SetupContext<string[]>,
) {
  const baseCtx = createBase(props);
  const { locale, masks, disabledAttribute } = baseCtx;
  const { emit } = ctx;

  const showCalendar = ref(false);
  const datePickerPopoverId = ref(createGuid());
  const dateValue = ref<null | Date | SimpleDateRange>(null);
  const dragValue = ref<null | SimpleDateRange>(null);
  const inputValues = ref<string[]>(['', '']);
  const popoverRef = ref<InstanceType<typeof Popover> | null>(null);
  const calendarRef = ref<InstanceType<typeof Calendar> | null>(null);

  let updateTimeout: undefined | number = undefined;
  let dragTrackingValue: null | SimpleDateRange;
  let watchValue = true;

  // #region Computed

  const isRange = computed(() => {
    return props.isRange || props.modelModifiers.range === true;
  });

  const valueStart = computed(() =>
    isRange.value && dateValue.value != null
      ? (dateValue.value as SimpleDateRange).start
      : null,
  );

  const valueEnd = computed(() =>
    isRange.value && dateValue.value != null
      ? (dateValue.value as SimpleDateRange).end
      : null,
  );

  const isDateMode = computed(() => props.mode.toLowerCase() === 'date');
  const isDateTimeMode = computed(
    () => props.mode.toLowerCase() === 'datetime',
  );
  const isTimeMode = computed(() => props.mode.toLowerCase() === 'time');

  const isDragging = computed(() => !!dragValue.value);

  const modelConfig = computed(() => {
    let type: DateType = 'date';
    if (props.modelModifiers.number) type = 'number';
    if (props.modelModifiers.string) type = 'string';
    const mask = masks.value.modelValue || 'iso';
    return normalizeDateConfig({ type, mask });
  });

  const dateParts = computed(() =>
    getDateParts(dragValue.value ?? dateValue.value),
  );

  const inputMask = computed(() => {
    if (isTimeMode.value) {
      return props.is24hr ? masks.value.inputTime24hr : masks.value.inputTime;
    }
    if (isDateTimeMode.value) {
      return props.is24hr
        ? masks.value.inputDateTime24hr
        : masks.value.inputDateTime;
    }
    return masks.value.input;
  });

  const inputMaskHasTime = computed(() => /[Hh]/g.test(inputMask.value));

  const inputMaskHasDate = computed(() =>
    /[dD]{1,2}|Do|W{1,4}|M{1,4}|YY(?:YY)?/g.test(inputMask.value),
  );

  const inputMaskPatch = computed(() => {
    if (inputMaskHasTime.value && inputMaskHasDate.value) {
      return 'dateTime';
    }
    if (inputMaskHasDate.value) return 'date';
    if (inputMaskHasTime.value) return 'time';
    return undefined;
  });

  const popover = computed(() => {
    const target = popoverRef.value?.$el.previousElementSibling ?? undefined;
    return defaultsDeep({}, props.popover, getDefault('datePicker.popover'), {
      target,
    }) as Partial<PopoverOptions>;
  });

  const popoverEvents = computed(() =>
    getPopoverEventHandlers({
      ...popover.value,
      id: datePickerPopoverId.value,
    }),
  );

  const inputValue = computed(() => {
    return isRange.value
      ? {
          start: inputValues.value[0],
          end: inputValues.value[1],
        }
      : inputValues.value[0];
  });

  const inputEvents = computed(() => {
    const events = (<ValueTarget[]>['start', 'end']).map(target => ({
      input: onInputInput(target),
      change: onInputChange(target),
      keyup: onInputKeyup,
      ...(props.popover && popoverEvents.value),
    }));
    return isRange.value
      ? {
          start: events[0],
          end: events[1],
        }
      : events[0];
  });

  const selectAttribute = computed(() => {
    if (!hasValue(dateValue.value)) return null;
    const attribute = {
      key: 'select-drag',
      ...props.selectAttribute,
      dates: dateValue.value,
      pinPage: true,
    };
    const { dot, bar, highlight, content } = attribute;
    if (!dot && !bar && !highlight && !content) {
      attribute.highlight = true;
    }
    return attribute;
  });

  const dragAttribute = computed(() => {
    if (!isRange.value || !hasValue(dragValue.value)) {
      return null;
    }
    const attribute = {
      key: 'select-drag',
      ...props.dragAttribute,
      dates: dragValue.value,
    };
    const { dot, bar, highlight, content } = attribute;
    if (!dot && !bar && !highlight && !content) {
      attribute.highlight = {
        startEnd: {
          fillMode: 'outline',
        },
      };
    }
    return attribute;
  });

  const attributes = computed(() => {
    const attrs = isArray(props.attributes) ? [...props.attributes] : [];
    if (dragAttribute.value) {
      attrs.unshift(dragAttribute.value);
    } else if (selectAttribute.value) {
      attrs.unshift(selectAttribute.value);
    }
    return attrs;
  });

  const rules = computed(() => {
    return normalizeConfig(
      props.rules === 'auto' ? getAutoRules() : props.rules ?? {},
    );
  });

  // #endregion Computed

  function getAutoRules() {
    const _rules = {
      ms: [0, 999],
      sec: [0, 59],
      min: [0, 59],
      hr: [0, 23],
    };
    const accuracy = isDateMode.value ? 0 : props.timeAccuracy;
    return [0, 1].map(i => {
      switch (accuracy) {
        case 0:
          return {
            hours: _rules.hr[i],
            minutes: _rules.min[i],
            seconds: _rules.sec[i],
            milliseconds: _rules.ms[i],
          };
        case 1:
          return {
            minutes: _rules.min[i],
            seconds: _rules.sec[i],
            milliseconds: _rules.ms[i],
          };
        case 3:
          return { milliseconds: _rules.ms[i] };
        case 4:
          return {};
        default:
          return { seconds: _rules.sec[i], milliseconds: _rules.ms[i] };
      }
    });
  }

  function normalizeConfig<T>(config: T | T[]): T[] {
    if (isArray(config)) {
      if (config.length === 1) return [config[0], config[0]];
      return config;
    }
    return [config, config];
  }

  function normalizeDateConfig(
    config: Partial<DateConfig> | Partial<DateConfig>[],
  ): DateConfig[] {
    return normalizeConfig(config).map(
      (c, i) =>
        ({
          ...c,
          rules: rules.value[i],
        } as DateConfig),
    );
  }

  function hasValue(value: any) {
    if (isRange.value) {
      return isObject(value) && value.start != null && value.end != null;
    }
    return value != null;
  }

  function datesAreEqual(a: any, b: any): boolean {
    const aIsDate = isDate(a);
    const bIsDate = isDate(b);
    if (!aIsDate && !bIsDate) return true;
    if (aIsDate !== bIsDate) return false;
    return a.getTime() === b.getTime();
  }

  function valuesAreEqual(a: any, b: any) {
    if (isRange.value) {
      const aHasValue = hasValue(a);
      const bHasValue = hasValue(b);
      if (!aHasValue && !bHasValue) return true;
      if (aHasValue !== bHasValue) return false;
      return datesAreEqual(a.start, b.start) && datesAreEqual(a.end, b.end);
    }
    return datesAreEqual(a, b);
  }

  function valueIsDisabled(value: any) {
    if (!hasValue(value) || !disabledAttribute.value) return false;
    return disabledAttribute.value.intersectsRange(locale.value.range(value));
  }

  function normalizeValue(
    value: any,
    config: DateConfig[],
    patch: DatePatch,
    targetPriority: ValueTarget,
  ): Date | SimpleDateRange | null {
    if (!hasValue(value)) return null;
    if (isRange.value) {
      let start = value.start > value.end ? value.end : value.start;
      start = locale.value.toDate(start, {
        ...config[0],
        fillDate: valueStart.value ?? undefined,
        patch,
      });
      let end = value.start > value.end ? value.start : value.end;
      end = locale.value.toDate(end, {
        ...config[1],
        fillDate: valueEnd.value ?? undefined,
        patch,
      });
      return sortRange({ start, end }, targetPriority);
    }
    return locale.value.toDate(value, {
      ...config[0],
      fillDate: dateValue.value as Date,
      patch,
    });
  }

  function denormalizeValue(value: any, config: DateConfig[]) {
    if (isRange.value) {
      if (!hasValue(value)) return null;
      return {
        start: locale.value.fromDate(value.start, config[0]),
        end: locale.value.fromDate(value.end, config[1]),
      };
    }
    return locale.value.fromDate(value, config[0]);
  }

  function updateValue(
    value: any,
    opts: Partial<UpdateOptions> = {},
  ): Promise<Date | SimpleDateRange | null> {
    clearTimeout(updateTimeout);
    return new Promise(resolve => {
      const { debounce = 0, ...args } = opts;
      if (debounce > 0) {
        updateTimeout = window.setTimeout(() => {
          forceUpdateValue(value, args);
          resolve(dateValue.value);
        }, debounce);
      } else {
        forceUpdateValue(value, args);
        resolve(dateValue.value);
      }
    });
  }

  function forceUpdateValue(
    value: any,
    {
      config = modelConfig.value,
      patch = 'dateTime',
      clearIfEqual = false,
      formatInput: fInput = true,
      hidePopover: hPopover = false,
      dragging = isDragging.value,
      targetPriority = 'both',
      moveToValue: mValue = false,
      loading = false,
    }: Partial<UpdateOptions> = {},
  ) {
    const valueRef = dragging ? dragValue : dateValue;
    // Notify after the first load by default
    let notify = !loading;

    // 1. Normalization
    const normalizedConfig = normalizeDateConfig(config);
    let normalizedValue = normalizeValue(
      value,
      normalizedConfig,
      patch,
      targetPriority,
    );

    // 2. Validation (date or range)
    const isDisabled = valueIsDisabled(normalizedValue);
    if (isDisabled) {
      if (dragging) return;
      if (loading) {
        notify = normalizedValue != null;
        normalizedValue = null;
      } else {
        normalizedValue = dateValue.value;
      }
      // Don't allow hiding popover
      hPopover = false;
    } else if (!loading) {
      const valuesEqual = valuesAreEqual(dateValue.value, normalizedValue);
      // Reset to previous value if it was cleared but is required
      if (normalizedValue == null && props.isRequired) {
        normalizedValue = dateValue.value;
        // Clear value if same value was passed
      } else if (normalizedValue != null && valuesEqual && clearIfEqual) {
        normalizedValue = null;
      } else {
        notify = !valuesEqual;
      }
    }

    // 3. Assignment
    valueRef.value = normalizedValue;
    // Clear drag value if needed
    if (!dragging) dragValue.value = null;

    // 4. Notification
    if (notify) {
      const event = isDragging.value ? 'drag' : 'update:modelValue';
      const denormalizedValue = denormalizeValue(
        normalizedValue,
        normalizedConfig,
      );
      watchValue = false;
      emit(event, denormalizedValue);
      nextTick(() => (watchValue = true));
    }

    // 5. Hide popover if needed
    if (hPopover && !dragging) hidePopover();

    // 6. Format inputs if needed
    if (fInput) formatInput();

    // 7. Move to range target if needed
    if (mValue) {
      nextTick(() => moveToValue(targetPriority));
    }
  }

  function formatInput() {
    nextTick(() => {
      const config = normalizeDateConfig({
        type: 'string',
        mask: inputMask.value,
      });
      const value = denormalizeValue(
        dragValue.value || dateValue.value,
        config,
      );
      if (isRange.value) {
        // @ts-ignore
        inputValues.value = [value && value.start, value && value.end];
      } else {
        inputValues.value = [value as string, ''];
      }
    });
  }

  function onInputUpdate(
    inputValue: string,
    target: ValueTarget,
    opts: Partial<UpdateOptions>,
  ) {
    inputValues.value.splice(target === 'start' ? 0 : 1, 1, inputValue);
    const value = isRange.value
      ? {
          start: inputValues.value[0],
          end: inputValues.value[1] || inputValues.value[0],
        }
      : inputValue;
    const config = {
      type: 'string',
      mask: inputMask.value,
    };
    updateValue(value, {
      ...opts,
      config,
      patch: inputMaskPatch.value,
      targetPriority: target,
      moveToValue: true,
    });
  }

  function onInputInput(target: ValueTarget) {
    return (e: InputEvent) => {
      if (!props.updateOnInput) return;
      onInputUpdate((<HTMLInputElement>e.currentTarget).value, target, {
        formatInput: false,
        hidePopover: false,
        debounce: props.inputDebounce,
      });
    };
  }

  function onInputChange(target: ValueTarget) {
    return (e: InputEvent) => {
      onInputUpdate((<HTMLInputElement>e.currentTarget).value, target, {
        formatInput: true,
        hidePopover: false,
      });
    };
  }

  function onInputKeyup(e: KeyboardEvent) {
    // Escape key only
    if (e.key !== 'Escape') return;
    updateValue(dateValue.value, {
      formatInput: true,
      hidePopover: true,
    });
  }

  function getDateParts(value: any): (DateParts | null)[] {
    if (isRange.value) {
      return [
        value && value.start ? locale.value.getDateParts(value.start) : null,
        value && value.end ? locale.value.getDateParts(value.end) : null,
      ];
    }
    return [value ? locale.value.getDateParts(value) : null];
  }

  function cancelDrag() {
    dragValue.value = null;
    formatInput();
  }

  function onPopoverBeforeShow(el: HTMLElement) {
    emit('popover-will-show', el);
  }

  function onPopoverAfterShow(el: HTMLElement) {
    emit('popover-did-show', el);
  }

  function onPopoverBeforeHide(el: HTMLElement) {
    cancelDrag();
    emit('popover-will-hide', el);
  }

  function onPopoverAfterHide(el: HTMLElement) {
    emit('popover-did-hide', el);
  }

  function handleDayClick(day: CalendarDay) {
    const opts: Partial<UpdateOptions> = {
      patch: 'date',
      formatInput: true,
      hidePopover: true,
    };
    if (isRange.value) {
      const dragging = !isDragging.value;
      if (dragging) {
        dragTrackingValue = { start: day.startDate, end: day.endDate };
      } else if (dragTrackingValue != null) {
        dragTrackingValue.end = day.date;
      }
      updateValue(dragTrackingValue, {
        ...opts,
        dragging,
        targetPriority: dragging ? 'none' : 'both',
      });
    } else {
      updateValue(day.date, {
        ...opts,
        clearIfEqual: !props.isRequired,
      });
    }
  }

  function onDayClick(day: CalendarDay, event: MouseEvent) {
    handleDayClick(day);
    // Re-emit event
    emit('dayclick', day, event);
  }

  function onDayKeydown(day: CalendarDay, event: KeyboardEvent) {
    switch (event.key) {
      case ' ':
      case 'Enter': {
        handleDayClick(day);
        event.preventDefault();
        break;
      }
      case 'Escape': {
        hidePopover();
      }
    }
    // Re-emit event
    emit('daykeydown', day, event);
  }

  function onDayMouseEnter(day: CalendarDay, event: MouseEvent) {
    if (!isDragging.value || dragTrackingValue == null) return;
    dragTrackingValue.end = day.date;
    updateValue(dragTrackingValue, {
      patch: 'date',
      formatInput: true,
      targetPriority: 'none',
    });
  }

  function showPopover(opts: Partial<PopoverOptions> = {}) {
    sp({
      ...popover.value,
      ...opts,
      isInteractive: true,
      id: datePickerPopoverId.value,
    });
  }

  function hidePopover(opts: Partial<PopoverOptions> = {}) {
    hp({
      hideDelay: 10,
      force: true,
      ...popover.value,
      ...opts,
      id: datePickerPopoverId.value,
    });
  }

  function togglePopover(opts: Partial<PopoverOptions>) {
    tp({
      ...popover.value,
      ...opts,
      isInteractive: true,
      id: datePickerPopoverId.value,
    });
  }

  function sortRange(range: any, priority = 'none') {
    const { start, end } = range;
    if (start > end) {
      switch (priority) {
        case 'start':
          return { start, end: start };
        case 'end':
          return { start: end, end };
        case 'both':
          return { start: end, end: start };
      }
    }
    return { start, end };
  }

  function getPageForValue(isStart: boolean) {
    if (hasValue(dateValue.value)) {
      const date = isRange.value
        ? isStart
          ? valueStart.value
          : valueEnd.value
        : dateValue.value;
      return getPageAddressForDate(date as Date, 'monthly', locale.value);
    }
    return null;
  }

  async function move(target: MoveTarget, opts: Partial<MoveOptions> = {}) {
    if (calendarRef.value == null) return false;
    return calendarRef.value.move(target, opts);
  }

  async function moveBy(pages: number, opts: Partial<MoveOptions> = {}) {
    if (calendarRef.value == null) return false;
    return calendarRef.value.moveBy(pages, opts);
  }

  async function moveToValue(
    target: ValueTarget,
    opts: Partial<MoveOptions> = {},
  ) {
    if (calendarRef.value == null || target === 'none') return false;
    const { firstPage, lastPage, move } = calendarRef.value;
    const start = target !== 'end';
    const page = getPageForValue(start);
    const position = start ? 1 : -1;
    if (!page || pageIsBetweenPages(page, firstPage, lastPage)) return false;
    return move(page, {
      position,
      ...opts,
    });
  }

  // #endregion Methods

  // #region Watch

  watch(
    () => props.isRange,
    val => {
      if (val) {
        console.warn(
          'The `is-range` prop will be deprecated in future releases. Please use the `range` modifier.',
        );
      }
    },
    { immediate: true },
  );
  watch(
    () => inputMask.value,
    () => formatInput(),
  );
  watch(
    () => props.modelValue,
    val => {
      if (!watchValue) return;
      forceUpdateValue(val, {
        formatInput: true,
        hidePopover: false,
      });
    },
  );
  watch(
    () => rules.value,
    () => {
      if (isObject(props.rules)) {
        forceUpdateValue(props.modelValue, {
          formatInput: true,
          hidePopover: false,
        });
      }
    },
  );
  watch(
    () => props.timezone,
    () => {
      forceUpdateValue(dateValue.value, { formatInput: true });
    },
  );

  // #endregion Watch

  // #region Lifecycle

  onMounted(() => {
    forceUpdateValue(props.modelValue, {
      formatInput: true,
      hidePopover: false,
      loading: true,
    });
  });

  // Created
  // Waiting a tick allows calendar to initialize page
  nextTick(() => (showCalendar.value = true));

  // #endregion Lifecycle

  const context = {
    ...baseCtx,
    showCalendar,
    datePickerPopoverId,
    popoverRef,
    popoverEvents,
    calendarRef,
    isRange,
    isTimeMode,
    isDateTimeMode,
    is24hr: toRef(props, 'is24hr'),
    hideTimeHeader: toRef(props, 'hideTimeHeader'),
    timeAccuracy: toRef(props, 'timeAccuracy'),
    isDragging,
    inputValue,
    inputEvents,
    dateParts,
    modelConfig,
    attributes,
    rules,
    move,
    moveBy,
    moveToValue,
    updateValue,
    showPopover,
    hidePopover,
    togglePopover,
    onDayClick,
    onDayKeydown,
    onDayMouseEnter,
    onPopoverBeforeShow,
    onPopoverAfterShow,
    onPopoverBeforeHide,
    onPopoverAfterHide,
  };
  provide(contextKey, context);
  return context;
}

export function useDatePicker() {
  const context = inject<DatePickerContext>(contextKey);
  if (context) return context;
  throw new Error(
    'DatePicker context missing. Please verify this component is nested within a valid context provider.',
  );
}
