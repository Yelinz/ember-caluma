import EmberObject, { computed, getWithDefault } from "@ember/object";
import { equal, not, empty, reads } from "@ember/object/computed";
import { inject as service } from "@ember/service";
import { assert } from "@ember/debug";
import { getOwner } from "@ember/application";
import { camelize } from "@ember/string";
import { task } from "ember-concurrency";
import { all, resolve } from "rsvp";
import { validate } from "ember-validators";
import Evented, { on } from "@ember/object/evented";

import Answer from "ember-caluma/lib/answer";
import Question from "ember-caluma/lib/question";
import { decodeId } from "ember-caluma/helpers/decode-id";

import saveDocumentFloatAnswerMutation from "ember-caluma/gql/mutations/save-document-float-answer";
import saveDocumentIntegerAnswerMutation from "ember-caluma/gql/mutations/save-document-integer-answer";
import saveDocumentStringAnswerMutation from "ember-caluma/gql/mutations/save-document-string-answer";
import saveDocumentListAnswerMutation from "ember-caluma/gql/mutations/save-document-list-answer";
import saveDocumentFileAnswerMutation from "ember-caluma/gql/mutations/save-document-file-answer";
import saveDocumentDateAnswerMutation from "ember-caluma/gql/mutations/save-document-date-answer";
import saveDocumentTableAnswerMutation from "ember-caluma/gql/mutations/save-document-table-answer";
import removeAnswerMutation from "ember-caluma/gql/mutations/remove-answer";

const TYPE_MAP = {
  TextQuestion: "StringAnswer",
  TextareaQuestion: "StringAnswer",
  IntegerQuestion: "IntegerAnswer",
  FloatQuestion: "FloatAnswer",
  MultipleChoiceQuestion: "ListAnswer",
  ChoiceQuestion: "StringAnswer",
  DynamicMultipleChoiceQuestion: "ListAnswer",
  DynamicChoiceQuestion: "StringAnswer",
  TableQuestion: "TableAnswer",
  FormQuestion: "FormAnswer",
  FileQuestion: "FileAnswer",
  StaticQuestion: null,
  DateQuestion: "DateAnswer"
};

/**
 * An object which represents a combination of a question and an answer.
 *
 * @class Field
 */
export default EmberObject.extend(Evented, {
  saveDocumentFloatAnswerMutation,
  saveDocumentIntegerAnswerMutation,
  saveDocumentStringAnswerMutation,
  saveDocumentListAnswerMutation,
  saveDocumentFileAnswerMutation,
  saveDocumentDateAnswerMutation,
  saveDocumentTableAnswerMutation,

  /**
   * The Apollo GraphQL service for making requests
   *
   * @property {ApolloService} apollo
   * @accessor
   */
  apollo: service(),

  /**
   * The translation service
   *
   * @property {IntlService} intl
   * @accessor
   */
  intl: service(),

  /**
   * Initialize function which validates the passed arguments and sets an
   * initial state of errors.
   *
   * @method init
   * @internal
   */
  init() {
    this._super(...arguments);

    assert("Owner must be injected!", getOwner(this));
    assert("_question must be passed!", this._question);

    const __typename = TYPE_MAP[this._question.__typename];

    const question = Question.create(
      getOwner(this).ownerInjection(),
      Object.assign(this._question, {
        document: this.document,
        field: this
      })
    );

    const answer =
      __typename &&
      Answer.create(
        getOwner(this).ownerInjection(),
        Object.assign(
          this._answer || {
            __typename,
            question: { slug: this._question.slug },
            [camelize(__typename.replace(/Answer$/, "Value"))]: null
          },
          { document: this.document, field: this }
        )
      );

    this.setProperties({
      _errors: [],
      dependentFields: { isRequired: [], isHidden: [] },
      question,
      answer
    });
  },

  /**
   * The ID of the field. Consists of the document ID and the question slug.
   *
   * E.g: `Document:b01e9071-c63a-43a5-8c88-2daa7b02e411:Question:some-question-slug`
   *
   * @property {String} id
   * @accessor
   */
  id: computed("document.id", "question.slug", function() {
    return `Document:${this.document.id}:Question:${this.question.slug}`;
  }).readOnly(),

  updateHidden: on("valueChanged", "hiddenChanged", function() {
    this.dependentFields.isHidden.forEach(field =>
      field.question.hiddenTask.perform()
    );
  }),

  updateOptional: on("valueChanged", "hiddenChanged", function() {
    this.dependentFields.isRequired.forEach(field =>
      field.question.optionalTask.perform()
    );
  }),

  registerDependentField(field, key) {
    this.set(`dependentFields.${key}`, [
      ...new Set(this.get(`dependentFields.${key}`)),
      field
    ]);
  },

  /**
   * Whether the field is valid.
   *
   * @property {Boolean} isValid
   * @accessor
   */
  isValid: equal("errors.length", 0),

  /**
   * Whether the field is invalid.
   *
   * @property {Boolean} isInvalid
   * @accessor
   */
  isInvalid: not("isValid"),

  /**
   * Whether the field is new (never saved to the backend service)
   *
   * @property {Boolean} isNew
   * @accessor
   */
  isNew: empty("answer.id"),

  /**
   * Whether the field is optional
   *
   * @property {Boolean} optional
   * @accessor
   */
  optional: reads("question.optional"),

  /**
   * Whether or not the question is hidden.
   * This is needed for the computed property in `cf-navigation-item`.
   * @property {Boolean} hidden
   * @accessor
   */
  hidden: reads("question.hidden"),

  /**
   * The type of the question
   *
   * @property {String} questionType
   * @accessor
   */
  questionType: reads("question.__typename"),

  visibleInNavigation: computed(
    "hidden",
    "questionType",
    "childDocument.visibleFields",
    function() {
      return (
        !this.hidden &&
        this.questionType === "FormQuestion" &&
        getWithDefault(this, "childDocument.visibleFields", []).length > 0
      );
    }
  ),

  /**
   * The error messages on this field.
   *
   * @property {String[]} errors
   * @accessor
   */
  errors: computed("_errors.[]", function() {
    return this._errors.map(({ type, context, value }) => {
      return this.intl.t(
        `caluma.form.validation.${type}`,
        Object.assign({}, context, { value })
      );
    });
  }).readOnly(),

  /**
   * Task to save a field. This uses a different mutation for every answer
   * type.
   *
   * @method save
   * @return {Object} The response from the server
   */
  save: task(function*() {
    const type = this.get("answer.__typename");
    const value = this.get("answer.value");

    let response;

    if (value === null || value.length === 0) {
      response = yield this.apollo.mutate(
        {
          mutation: removeAnswerMutation,
          variables: {
            input: {
              answer: decodeId(this.get("answer.id"))
            }
          }
        },
        `removeAnswer.answer`
      );

      this.answer.id = undefined;
    } else {
      response = yield this.apollo.mutate(
        {
          mutation: this.get(`saveDocument${type}Mutation`),
          variables: {
            input: {
              question: this.get("question.slug"),
              document: this.get("document.id"),
              value
            }
          }
        },
        `saveDocument${type}.answer`
      );

      this.answer.setProperties(response);
    }

    return response;
  }).restartable(),

  /**
   * Validate the field. Every field goes through the required validation and
   * the validation for the given question type. This mutates the `errors` on
   * the field.
   *
   * @method validate
   */
  validate: task(function*() {
    const specificValidation = this.get(`_validate${this.question.__typename}`);
    assert(
      "Missing validation function for " + this.question.__typename,
      specificValidation
    );

    const validationFns = [
      ...(!this.question.hidden ? [this._validateRequired] : []),
      specificValidation
    ];

    const errors = (yield all(
      validationFns.map(async fn => {
        const res = await fn.call(this);

        return Array.isArray(res) ? res : [res];
      })
    ))
      .reduce((arr, e) => [...arr, ...e], []) // flatten the array
      .filter(e => typeof e === "object");

    this.set("_errors", errors);
  }).restartable(),

  /**
   * Method to validate if a question is required or not.
   *
   * @method _validateRequired
   * @return {RSVP.Promise} Returns an promise which resolves into an object if invalid or true if valid
   * @internal
   */
  async _validateRequired() {
    return (
      (await this.get("question.optional")) ||
      validate("presence", this.get("answer.value"), { presence: true })
    );
  },

  /**
   * Method to validate a text question. This checks if the value longer than
   * predefined by the question.
   *
   * @method _validateTextQuestion
   * @return {Object|Boolean} Returns an object if invalid or true if valid
   * @internal
   */
  _validateTextQuestion() {
    return validate("length", this.get("answer.value"), {
      max: this.get("question.textMaxLength") || Number.POSITIVE_INFINITY
    });
  },

  /**
   * Method to validate a textarea question. This checks if the value longer
   * than predefined by the question.
   *
   * @method _validateTextareaQuestion
   * @return {Object|Boolean} Returns an object if invalid or true if valid
   * @internal
   */
  _validateTextareaQuestion() {
    return validate("length", this.get("answer.value"), {
      max: this.get("question.textareaMaxLength") || Number.POSITIVE_INFINITY
    });
  },

  /**
   * Method to validate an integer question. This checks if the value is bigger
   * or less than the options provided by the question.
   *
   * @method _validateIntegerQuestion
   * @return {Object|Boolean} Returns an object if invalid or true if valid
   * @internal
   */
  _validateIntegerQuestion() {
    return validate("number", this.get("answer.value"), {
      integer: true,
      gte: this.get("question.integerMinValue") || Number.NEGATIVE_INFINITY,
      lte: this.get("question.integerMaxValue") || Number.POSITIVE_INFINITY
    });
  },

  /**
   * Method to validate a float question. This checks if the value is bigger or
   * less than the options provided by the question.
   *
   * @method _validateFloatQuestion
   * @return {Object|Boolean} Returns an object if invalid or true if valid
   * @internal
   */
  _validateFloatQuestion() {
    return validate("number", this.get("answer.value"), {
      gte: this.get("question.floatMinValue") || Number.NEGATIVE_INFINITY,
      lte: this.get("question.floatMaxValue") || Number.POSITIVE_INFINITY
    });
  },

  /**
   * Method to validate a radio question. This checks if the value is included
   * in the provided options of the question.
   *
   * @method _validateChoiceQuestion
   * @return {Object|Boolean} Returns an object if invalid or true if valid
   * @internal
   */
  _validateChoiceQuestion() {
    return validate("inclusion", this.get("answer.value"), {
      allowBlank: true,
      in: this.getWithDefault("question.choiceOptions.edges", []).map(
        option => option.node.slug
      )
    });
  },

  /**
   * Method to validate a checkbox question. This checks if the all of the
   * values are included in the provided options of the question.
   *
   * @method _validateMultipleChoiceQuestion
   * @return {Object[]|Boolean[]|Mixed[]} Returns per value an object if invalid or true if valid
   * @internal
   */
  _validateMultipleChoiceQuestion() {
    const value = this.get("answer.value");
    if (!value) {
      return true;
    }
    return value.map(value =>
      validate("inclusion", value, {
        in: this.getWithDefault("question.multipleChoiceOptions.edges", []).map(
          option => option.node.slug
        )
      })
    );
  },

  /**
   * Method to validate a radio question. This checks if the value is included
   * in the provided options of the question.
   *
   * @method _validateChoiceQuestion
   * @return {Object|Boolean} Returns an object if invalid or true if valid
   * @internal
   */
  _validateDynamicChoiceQuestion() {
    return validate("inclusion", this.get("answer.value"), {
      in: this.getWithDefault("question.dynamicChoiceOptions.edges", []).map(
        option => option.node.slug
      )
    });
  },

  /**
   * Method to validate a checkbox question. This checks if the all of the
   * values are included in the provided options of the question.
   *
   * @method _validateMultipleChoiceQuestion
   * @return {Object[]|Boolean[]|Mixed[]} Returns per value an object if invalid or true if valid
   * @internal
   */
  _validateDynamicMultipleChoiceQuestion() {
    const value = this.get("answer.value");
    if (!value) {
      return true;
    }
    return value.map(value => {
      return validate("inclusion", value, {
        in: this.getWithDefault(
          "question.dynamicMultipleChoiceOptions.edges",
          []
        ).map(option => option.node.slug)
      });
    });
  },

  /**
   * Dummy method for the validation of file uploads.
   *
   * @method _validateFileQuestion
   * @return {Boolean}
   * @internal
   */
  _validateFileQuestion() {
    return resolve(true);
  },

  /**
   * Method to validate a date question.
   *
   * @method _validateDateQuestion
   * @return {Object[]|Boolean[]|Mixed[]} Returns per value an object if invalid or true if valid
   * @internal
   */
  _validateDateQuestion() {
    return validate("date", this.get("answer.value"), {
      allowBlank: true
    });
  },

  /**
   * Dummy method for the validation of table fields
   *
   * @method _validateTableQuestion
   * @return {RSVP.Promise}
   * @internal
   */
  _validateTableQuestion() {
    return resolve(true);
  },

  /**
   * Dummy method for the validation of static fields
   *
   * @method _validateStaticQuestion
   * @return {RSVP.Promise}
   * @internal
   */
  _validateStaticQuestion() {
    return resolve(true);
  }
});
