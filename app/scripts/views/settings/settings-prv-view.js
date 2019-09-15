import Backbone from 'backbone';
import { Storage } from 'storage';

const SettingsPrvView = Backbone.View.extend({
    template: require('templates/settings/settings-prv.hbs'),

    events: {
        'change .settings__general-prv-field-sel': 'changeField',
        'input .settings__general-prv-field-txt': 'changeField'
    },

    render() {
        const storage = Storage[this.model.name];
        if (storage && storage.getSettingsConfig) {
            this.renderTemplate(storage.getSettingsConfig());
        }
        return this;
    },

    changeField(e) {
        const id = e.target.dataset.id;
        const value = e.target.value;
        if (!e.target.checkValidity()) {
            return;
        }
        const storage = Storage[this.model.name];
        storage.applySetting(id, value);
        if ($(e.target).is('select')) {
            this.render();
        }
    }
});

export { SettingsPrvView };
