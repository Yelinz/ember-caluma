import { register } from "ember-caluma/mirage-graphql";
import BaseMock from "ember-caluma/mirage-graphql/mocks/base";

export default class extends BaseMock {
  @register("Answer")
  handleAnswer({ __typename }) {
    return { __typename };
  }

  _handleSaveDocumentAnswer(
    _,
    {
      question: questionSlug,
      document: documentId,
      clientMutationId,
      value,
      type,
    }
  ) {
    const questionId = this.db.questions.findBy({ slug: questionSlug }).id;

    const answer = this.collection.findBy({ questionId, documentId });

    const res = this.handleSavePayload.fn.call(this, _, {
      input: {
        id: answer && answer.id,
        type,
        value,
        documentId,
        questionId,
        clientMutationId,
      },
    });

    const doc = this.db.documents.findBy({ id: res.answer.documentId });

    this.db.documents.update(doc.id, {
      answerIds: [...new Set([...(doc.answerIds || []), res.answer.id])],
    });

    return res;
  }

  @register("SaveDocumentStringAnswerPayload")
  handleSaveDocumentStringAnswer(_, { input }) {
    return this._handleSaveDocumentAnswer(_, {
      ...input,
      value: String(input.value),
      type: "STRING",
    });
  }

  @register("SaveDocumentIntegerAnswerPayload")
  handleSaveIntegerAnswer(_, { input }) {
    return this._handleSaveDocumentAnswer(_, {
      ...input,
      value: parseInt(input.value),
      type: "INTEGER",
    });
  }

  @register("SaveDocumentFloatAnswerPayload")
  handleSaveFloatAnswer(_, { input }) {
    return this._handleSaveDocumentAnswer(_, {
      ...input,
      value: parseFloat(input.value),
      type: "FLOAT",
    });
  }

  @register("SaveDocumentListAnswerPayload")
  handleSaveListAnswer(_, { input }) {
    return this._handleSaveDocumentAnswer(_, {
      ...input,
      value: [...input.value].map(String),
      type: "LIST",
    });
  }

  @register("SaveDocumentFileAnswerPayload")
  handleSaveFileAnswer(_, { input }) {
    return this._handleSaveDocumentAnswer(_, {
      ...input,
      value: { metadata: { object_name: input.value } },
      type: "FILE",
    });
  }

  @register("SaveDocumentDateAnswerPayload")
  handleSaveDateAnswer(_, { input }) {
    return this._handleSaveDocumentAnswer(_, {
      ...input,
      value: String(input.value),
      type: "DATE",
    });
  }
}
